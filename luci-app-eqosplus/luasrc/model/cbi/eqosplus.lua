-- Copyright 2022-2023 sirpdboy <herboy2008@gmail.com>
-- Licensed to the public under the Apache License 2.0.
local sys = require "luci.sys"
local http = require "luci.http"
local ifaces = sys.net:devices()
local WADM = require "luci.tools.webadmin"
local ipc = require "luci.ip"
local a, t, e

a = Map("eqosplus", translate("Network speed limit"))
a.description = translate("Users can limit the network speed for uploading/downloading through MAC, IP, and IP segments (192.168.10.100-192.168.10.200). The speed unit is MB/second.")
a.template = "eqosplus/index"

t = a:section(TypedSection, "eqosplus")
t.anonymous = true

e = t:option(Flag, "enabled", translate("Eqos switch"))
e.rmempty = false
e.default = "0"

e = t:option(DummyValue, "eqosplus_status", translate("Status"))
e.template = "eqosplus/eqosplus"
e.value = translate("Collecting data...")

t = a:section(TypedSection, "device")
t.template = "cbi/tblsection"
t.anonymous = true
t.addremove = true

comment = t:option(Value, "comment", translate("Comment"))
comment.size = 8

e = t:option(Flag, "enable", translate("Enabled"))
e.rmempty = false
e.size = 4

ip = t:option(Value, "mac", translate("IP/MAC"))
ip.size = 8

local function normalize_target(value)
    value = value and value:match("^%s*(.-)%s*$") or ""

    if value:match("^[0-9a-fA-F][0-9a-fA-F][:%-][0-9a-fA-F][0-9a-fA-F][:%-][0-9a-fA-F][0-9a-fA-F][:%-][0-9a-fA-F][0-9a-fA-F][:%-][0-9a-fA-F][0-9a-fA-F][:%-][0-9a-fA-F][0-9a-fA-F]$") then
        return value:lower()
    end

    return value
end

function validate_target(self, value, section)
    value = normalize_target(value)

    if value ~= "" then
        return value
    end

    return nil, translate("IP/MAC required")
end

ip.validate = validate_target

local function get_devices()
    local devices = {}
    local seen_ips = {}
    local ubus = require "ubus"
    local conn = ubus.connect()

    local function format_device_display(ip, hostname)
        if hostname and hostname ~= "" and hostname ~= "unknown" then
            return string.format("%s - %s", ip, hostname)
        end

        return ip
    end
    
    local function get_hostname(ip)
        local f = io.popen("nslookup "..ip.." 2>/dev/null | grep 'name =' | cut -d'=' -f2 | sed 's/\\.$//'")
        if f then
            local name = f:read("*l")
            f:close()
            if name and name ~= "" then
                return name:match("^%s*(.-)%s*$")
            end
        end
        local leases_file = io.open("/tmp/dhcp.leases", "r")
        if leases_file then
            for line in leases_file:lines() do
                local mac, ip_lease, _, hostname = line:match("^(%S+)%s+(%S+)%s+(%S+)%s+(%S+)")
                if ip_lease == ip and hostname ~= "*" then
                    leases_file:close()
                    return hostname
                end
            end
            leases_file:close()
        end
       return "unknown"
    end
    if conn then
        local leases = conn:call("dhcp", "ipv4leases", {}) or {}
        for _, lease in ipairs(leases) do
            if lease.ipaddr and lease.mac then
                local hostname = lease.hostname or get_hostname(lease.ipaddr)
                devices[#devices+1] = {
                    ip = lease.ipaddr,
                    mac = lease.mac:lower(),
                    hostname = hostname,
                    display = format_device_display(lease.ipaddr, hostname)
                }
                seen_ips[lease.ipaddr] = true
            end
        end
        conn:close()
    end
    local arp_cmd = io.popen("ip -4 neigh show dev br-lan 2>/dev/null")
    if arp_cmd then
        for line in arp_cmd:lines() do
            local ip_addr, mac = line:match("^(%S+)%s+.+%s+(%S+)%s+")
            if ip_addr and mac and mac ~= "00:00:00:00:00:00" and not seen_ips[ip_addr] then
                mac = mac:lower()
                local hostname = get_hostname(ip_addr)
                devices[#devices+1] = {
                    ip = ip_addr,
                    mac = mac,
                    hostname = hostname,
                    display = format_device_display(ip_addr, hostname)
                }
                seen_ips[ip_addr] = true
            end
        end
        arp_cmd:close()
    end
    table.sort(devices, function(a, b) return a.ip < b.ip end)
    return devices
end

local devices = get_devices()
for _, dev in ipairs(devices) do
    ip:value(dev.ip, dev.display)
end
dl = t:option(Value, "download", translate("Downloads"))
dl.default = '1'
dl.size = 4

ul = t:option(Value, "upload", translate("Uploads"))
ul.default = '1'
ul.size = 4

local timestart_option, timeend_option

local function valid_time_value(value)
    return value and value:match("^([01]%d|2[0-3]):[0-5]%d$")
end

local function time_to_minutes(value)
    local hour, minute = value:match("^(%d%d):(%d%d)$")
    return tonumber(hour) * 60 + tonumber(minute)
end

local function posted_value(option, section, current, value)
    if option == current then
        return value
    end

    if option then
        local posted = http.formvalue(option:cbid(section))
        if posted and posted ~= "" then
            return posted
        end
    end

    return option and option:cfgvalue(section) or nil
end

function validate_time(self, value, section)
    if not valid_time_value(value) then
        return nil, translate("Please enter time in HH:MM format")
    end

    local timestart = posted_value(timestart_option, section, self, value)
    local timeend = posted_value(timeend_option, section, self, value)

    if valid_time_value(timestart) and valid_time_value(timeend) and
        time_to_minutes(timestart) >= time_to_minutes(timeend) then
        return nil, translate("Start control time must be earlier than stop control time")
    end

    return value
end

timestart_option = t:option(Value, "timestart", translate("Start control time"))
timestart_option.placeholder = '00:00'
timestart_option.default = '00:00'
timestart_option.validate = validate_time
timestart_option.rmempty = true
timestart_option.size = 4

timeend_option = t:option(Value, "timeend", translate("Stop control time"))
timeend_option.placeholder = '23:59'
timeend_option.default = '23:59'
timeend_option.validate = validate_time
timeend_option.rmempty = true
timeend_option.size = 4

week=t:option(Value,"week",translate("Week Day(1~7)"))
week.rmempty = true
week:value('0',translate("Everyday"))
week:value(1,translate("Monday"))
week:value(2,translate("Tuesday"))
week:value(3,translate("Wednesday"))
week:value(4,translate("Thursday"))
week:value(5,translate("Friday"))
week:value(6,translate("Saturday"))
week:value(7,translate("Sunday"))
week:value('1,2,3,4,5',translate("Workday"))
week:value('6,7',translate("Rest Day"))
week.default='0'
week.size = 6

return a
