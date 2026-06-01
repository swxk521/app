module("luci.controller.timecontrol", package.seeall)
-- Copyright 2022-2025 sirpdboy <herboy2008@gmail.com>
function index()
    if not nixio.fs.access("/etc/config/timecontrol") then return end

    local e = entry({"admin", "services", "timecontrol"}, cbi("timecontrol"), _("Timecontrol"), 20)
    e.dependent=false
    e.acl_depends = { "luci-app-timecontrol" }
    entry({"admin", "services", "timecontrol", "status"}, call("act_status")).leaf = true
end

function act_status()
    local sys  = require "luci.sys"
    local uci  = require "luci.model.uci".cursor()
    local enabled = uci:get("timecontrol", "@timecontrol[0]", "enabled") == "1"
    local e = {} 
    e.status = enabled and (sys.call(" busybox ps -w | grep timecontrol | grep -v grep  >/dev/null ") == 0)
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end
