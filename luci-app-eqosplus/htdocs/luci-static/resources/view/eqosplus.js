'use strict';
'require form';
'require fs';
'require poll';
'require rpc';
'require uci';
'require view';

var CONFIG = 'eqosplus';
var MAIN_SECTION = 'eqosplus';
var PROCESS_NAME = 'eqosplus';
var STATUS_ID = 'eqosplus-status';

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function trimValue(value) {
	return (value == null) ? '' : String(value).replace(/^\s+|\s+$/g, '');
}

function validMac(value) {
	return /^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(value);
}

function looksLikeMac(value) {
	value = trimValue(value);

	return /^[0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}$/i.test(value) ||
	       /^[0-9a-f]{12}$/i.test(value);
}

function normalizeTarget(value) {
	value = trimValue(value);

	return validMac(value) ? value.toLowerCase() : value;
}

function validateTarget(section_id, value) {
	value = normalizeTarget(value);

	if (value == '')
		return _('IP/MAC required');

	if (validMac(value))
		return true;

	if (value.indexOf(':') > -1 || looksLikeMac(value))
		return _('Please enter MAC in xx:xx:xx:xx:xx:xx format');

	return validIpTarget(value)
		? true
		: _('Please enter a valid IPv4, CIDR, IP range (192.168.10.100-200), or MAC address');
}

function parseIPv4(value) {
	var parts = trimValue(value).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	var octets = [];

	if (!parts)
		return null;

	for (var i = 1; i <= 4; i++) {
		var number = +parts[i];

		if (number < 0 || number > 255)
			return null;

		octets.push(number);
	}

	return octets;
}

function validIPv4(value) {
	return parseIPv4(value) != null;
}

function ipv4ToInt(octets) {
	return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
}

function validCidrTarget(value) {
	var parts = trimValue(value).split('/');
	var prefix;

	if (parts.length != 2 || !parseIPv4(parts[0]) || !/^\d+$/.test(parts[1]))
		return false;

	prefix = +parts[1];

	return prefix >= 0 && prefix <= 32;
}

function validRangeTarget(value) {
	var parts = trimValue(value).split('-');
	var start, end, last;

	if (parts.length != 2)
		return false;

	start = parseIPv4(parts[0]);

	if (!start)
		return false;

	if (/^\d+$/.test(trimValue(parts[1]))) {
		last = +trimValue(parts[1]);

		if (last < 0 || last > 255)
			return false;

		end = [ start[0], start[1], start[2], last ];
	}
	else {
		end = parseIPv4(parts[1]);

		if (!end)
			return false;
	}

	return ipv4ToInt(start) <= ipv4ToInt(end);
}

function validIpTarget(value) {
	value = trimValue(value);

	if (value.indexOf('-') > -1)
		return validRangeTarget(value);

	if (value.indexOf('/') > -1)
		return validCidrTarget(value);

	return validIPv4(value);
}

function validTime(value) {
	var match = trimValue(value).match(/^(\d\d):(\d\d)$/);

	if (!match)
		return false;

	return +match[1] <= 23 && +match[2] <= 59;
}

function timeToMinutes(value) {
	var match = trimValue(value).match(/^(\d\d):(\d\d)$/);

	return +match[1] * 60 + +match[2];
}

function optionFormValue(map, option, section_id) {
	var opt = map.lookupOption(option, section_id)[0];
	var value = opt ? opt.formvalue(section_id) : null;

	return (value != null && value !== '') ? value : null;
}

function validateTimePair(option, section_id, value) {
	var timestart, timeend;

	if (value == null || value === '')
		return true;

	if (!validTime(value))
		return _('Please enter time in HH:MM format');

	timestart = (option.option == 'timestart') ? value : optionFormValue(option.map, 'timestart', section_id);
	timeend = (option.option == 'timeend') ? value : optionFormValue(option.map, 'timeend', section_id);

	if (validTime(timestart) && validTime(timeend) &&
	    timeToMinutes(timestart) >= timeToMinutes(timeend))
		return _('Start control time must be earlier than stop control time');

	return true;
}

function validateWeekDays(section_id, value) {
	value = trimValue(value);

	if (value == '')
		return _('Please enter 0 or weekdays from 1 to 7 separated by commas');

	if (value == '0')
		return true;

	return /^([1-7]\s*,\s*)*[1-7]$/.test(value)
		? true
		: _('Please enter 0 or weekdays from 1 to 7 separated by commas');
}

function ipToString(value) {
	if (typeof(value) == 'string')
		return value.replace(/\/\d+$/, '');

	if (L.isObject(value) && value.address)
		return value.address;

	return '';
}

function ipCompare(a, b) {
	var aa = a[0].split('.').map(function(part) { return +part; });
	var bb = b[0].split('.').map(function(part) { return +part; });

	for (var i = 0; i < 4; i++)
		if (aa[i] != bb[i])
			return aa[i] - bb[i];

	return 0;
}

function collectDevices(hosts) {
	var devices = [];
	var seen = {};

	for (var mac in hosts) {
		var host = hosts[mac] || {};
		var ips = L.toArray(host.ipaddrs || host.ipv4);

		for (var i = 0; i < ips.length; i++) {
			var ip = ipToString(ips[i]);

			if (!validIPv4(ip) || seen[ip])
				continue;

			seen[ip] = true;
			devices.push([ ip, (host.name && host.name != 'unknown' && host.name != '*') ? '%s - %s'.format(ip, host.name) : ip ]);
		}
	}

	return devices.sort(ipCompare);
}

function hasProcess(stdout) {
	var lines = String(stdout || '').split(/\n/);

	for (var i = 0; i < lines.length; i++)
		if (lines[i].indexOf(PROCESS_NAME) > -1 && lines[i].indexOf('grep') == -1)
			return true;

	return false;
}

function enabledConfig() {
	return L.resolveDefault(uci.load(CONFIG), null).then(function() {
		var sections = uci.sections(CONFIG, MAIN_SECTION);

		return sections.length > 0 && sections[0].enabled == '1';
	});
}

function queryStatus() {
	return enabledConfig().then(function(enabled) {
		if (!enabled)
			return false;

		return L.resolveDefault(fs.exec('/bin/busybox', [ 'ps', '-w' ]), {}).then(function(res) {
			return hasProcess(res.stdout);
		});
	}).catch(function() {
		return false;
	});
}

function updateStatus() {
	return queryStatus().then(function(running) {
		var status = document.getElementById(STATUS_ID);

		if (!status)
			return;

		status.style.fontWeight = 'bold';
		status.style.color = running ? 'green' : 'red';
		status.textContent = running ? _('RUNNING') : _('NOT RUNNING');
	});
}

function addWeekValues(option) {
	option.value('0', _('Everyday'));
	option.value('1', _('Monday'));
	option.value('2', _('Tuesday'));
	option.value('3', _('Wednesday'));
	option.value('4', _('Thursday'));
	option.value('5', _('Friday'));
	option.value('6', _('Saturday'));
	option.value('7', _('Sunday'));
	option.value('1,2,3,4,5', _('Workday'));
	option.value('6,7', _('Rest Day'));
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callHostHints(), {})
		]);
	},

	render: function(data) {
		var devices = collectDevices(data[0]);
		var m, s, o;

		m = new form.Map(CONFIG, _('Network speed limit'),
			_('Users can limit the network speed for uploading/downloading through MAC, IP, and IP segments (192.168.10.100-200). The speed unit is MB/second.'));

		s = m.section(form.TypedSection, MAIN_SECTION);
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Eqos switch'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.DummyValue, '_status', _('Status'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return '<span id="%s" style="font-weight:bold;color:gray">%s</span>'.format(STATUS_ID, _('Collecting data...'));
		};

		s = m.section(form.GridSection, 'device');
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;

		o = s.option(form.Value, 'comment', _('Comment'));
		o.editable = true;
		o.width = '8em';

		o = s.option(form.Flag, 'enable', _('Enabled'));
		o.editable = true;
		o.rmempty = false;
		o.default = '0';
		o.width = '3em';

		o = s.option(form.Value, 'mac', _('IP/MAC'));
		o.editable = true;
		o.rmempty = false;
		o.width = '15em';
		for (var i = 0; i < devices.length; i++)
			o.value(devices[i][0], devices[i][1]);
		o.validate = validateTarget;
		o.write = function(section_id, value) {
			uci.set(CONFIG, section_id, 'mac', normalizeTarget(value));
		};

		o = s.option(form.Value, 'download', _('DownloadsMB'));
		o.editable = true;
		o.placeholder = '0.1';
		o.default = '0.1';
		o.width = '6em';

		o = s.option(form.Value, 'upload', _('UploadsMB'));
		o.editable = true;
		o.placeholder = '0.1';
		o.default = '0.1';
		o.width = '6em';

		o = s.option(form.Value, 'timestart', _('Start control time'));
		o.editable = true;
		o.placeholder = '00:00';
		o.default = '00:00';
		o.rmempty = true;
		o.width = '7em';
		o.validate = function(section_id, value) {
			return validateTimePair(this, section_id, value);
		};

		o = s.option(form.Value, 'timeend', _('Stop control time'));
		o.editable = true;
		o.placeholder = '23:59';
		o.default = '23:59';
		o.rmempty = true;
		o.width = '7em';
		o.validate = function(section_id, value) {
			return validateTimePair(this, section_id, value);
		};

		o = s.option(form.Value, 'week', _('Week Day(1~7)'));
		o.editable = true;
		o.rmempty = false;
		o.width = '15em';
		o.validate = validateWeekDays;
		addWeekValues(o);

		return m.render().then(function(node) {
			poll.add(updateStatus, 2);
			updateStatus();
			return node;
		});
	}
});
