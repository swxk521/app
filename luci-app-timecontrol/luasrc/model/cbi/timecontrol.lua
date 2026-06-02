-- Copyright 2022-2023 sirpdboy <herboy2008@gmail.com>
-- Licensed to the public under the Apache License 2.0.
local sys = require "luci.sys"
local http = require "luci.http"
local ifaces = sys.net:devices()
local WADM = require "luci.tools.webadmin"
local ipc = require "luci.ip"
local a, t, e

a = Map("timecontrol", translate("Internet time control"))
a.description = translate("Users can limit their internet usage time through MAC and IP, with available IP ranges such as 192.168.110.00 to 192.168.10.200,Managed devices will be unable to access the soft router's administrative interface!")
.. "<br />"
.. translate("When the start and end times are the same, enable viewing and rest time control, cycling in minutes in a repeating loop.")
a.template = "timecontrol/index"

t = a:section(TypedSection, "timecontrol")
t.anonymous = true

e = t:option(Flag, "enabled", translate("Timecontrol switch"))
e.rmempty = false
e.default = "0"

e = t:option(DummyValue, "timecontrol_status", translate("Status"))
e.template = "timecontrol/timecontrol"
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

    if value:match("^[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]$") then
        return value:lower()
    end

    return value
end

local function valid_ipv4(value)
    local parts = { value:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$") }

    if #parts ~= 4 then
        return false
    end

    for _, part in ipairs(parts) do
        local number = tonumber(part)
        if not number or number > 255 then
            return false
        end
    end

    return true
end

local function valid_target(value)
    if valid_ipv4(value) then
        return true
    end

    local start_ip, end_ip = value:match("^([^%-]+)%-(.+)$")
    if start_ip and end_ip and valid_ipv4(start_ip) and valid_ipv4(end_ip) then
        return true
    end

    local ipaddr, mask = value:match("^([^/]+)/(%d+)$")
    if ipaddr and valid_ipv4(ipaddr) and tonumber(mask) and tonumber(mask) <= 32 then
        return true
    end

    return value:match("^[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]$") ~= nil
end

local function looks_like_bad_mac(value)
    local hex = value:gsub("[^0-9a-fA-F]", "")
    return #hex == 12 and value:find(":") == nil
end

function validate_target(self, value, section)
    value = normalize_target(value)

    if value == "" then
        return nil, translate("IP/MAC required")
    end

    if valid_target(value) then
        return value
    end

    if looks_like_bad_mac(value) then
        return nil, translate("MAC address must use colon-separated format")
    end

    return nil, translate("Invalid IP/MAC format")
end

ip.validate = validate_target

-- 替换原有的 get_devices() 函数
local function get_devices()
    local devices = {}
    local seen_ips = {}
    local ubus = require "ubus"
    local conn = ubus.connect()

    local function device_label(ip, hostname)
        if hostname and hostname ~= "" and hostname ~= "unknown" and hostname ~= "*" then
            return string.format("%s - %s", ip, hostname)
        end

        return ip
    end
    
    -- 辅助函数：尝试获取主机名
    local function get_hostname(ip)
        -- 方法1: 使用 nslookup
        local f = io.popen("nslookup "..ip.." 2>/dev/null | grep 'name =' | cut -d'=' -f2 | sed 's/\\.$//'")
        if f then
            local name = f:read("*l")
            f:close()
            if name and name ~= "" then
                return name:match("^%s*(.-)%s*$")  -- 去除前后空格
            end
        end
        
        -- 方法2: 读取 /tmp/dhcp.leases
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

    -- 1. 从DHCP租约获取设备
    if conn then
        local leases = conn:call("dhcp", "ipv4leases", {}) or {}
        for _, lease in ipairs(leases) do
            if lease.ipaddr and lease.mac then
                local hostname = lease.hostname or get_hostname(lease.ipaddr)
                local mac = lease.mac:lower()
                devices[#devices+1] = {
                    ip = lease.ipaddr,
                    mac = mac,
                    hostname = hostname,
                    display = device_label(lease.ipaddr, hostname)
                }
                seen_ips[lease.ipaddr] = true
            end
        end
        conn:close()
    end

    -- 2. 从ARP表获取设备（使用ip neigh命令）
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
                    display = device_label(ip_addr, hostname)
                }
                seen_ips[ip_addr] = true
            end
        end
        arp_cmd:close()
    end

    -- 按IP地址排序设备列表
    table.sort(devices, function(a, b) return a.ip < b.ip end)
    
    return devices
end


-- 添加设备选项
local devices = get_devices()
for _, dev in ipairs(devices) do
    ip:value(dev.ip, dev.display)
end

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
        time_to_minutes(timestart) > time_to_minutes(timeend) then
        return nil, translate("Start control time must not be later than stop control time")
    end

    return value
end

function validate_minutes(self, value, section)
    local minutes
    if value and string.match(value, "^%d+$") then
        minutes = tonumber(value)
    end

    if minutes and minutes > 0 then
        return value
    else
        return nil, translate("Please enter a positive integer")
    end
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

e = t:option(Value, "watchtime", translate("Viewing time"))
e.placeholder = '15'
e.default = '15'
e.validate = validate_minutes
e.rmempty = true
e.size = 4

e = t:option(Value, "resttime", translate("Rest time"))
e.placeholder = '5'
e.default = '5'
e.validate = validate_minutes
e.rmempty = true
e.size = 4

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
