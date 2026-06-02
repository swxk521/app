'use strict';
'require form';
'require fs';
'require poll';
'require rpc';
'require uci';
'require view';

var CONFIG = 'timecontrol';
var MAIN_SECTION = 'timecontrol';
var PROCESS_NAME = 'timecontrol';
var STATUS_ID = 'timecontrol-status';

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

function normalizeTarget(value) {
	value = trimValue(value);

	return validMac(value) ? value.toLowerCase() : value;
}

function validIPv4(value) {
	var parts = trimValue(value).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);

	if (!parts)
		return false;

	for (var i = 1; i <= 4; i++) {
		var number = +parts[i];

		if (number > 255)
			return false;
	}

	return true;
}

function ipv4ToNumber(value) {
	var parts = trimValue(value).split('.');

	return (+parts[0]) * 16777216 + (+parts[1]) * 65536 + (+parts[2]) * 256 + (+parts[3]);
}

function validIPv4Range(start, end) {
	return validIPv4(start) && validIPv4(end) && ipv4ToNumber(start) <= ipv4ToNumber(end);
}

function validIPv4ShortRange(start, end) {
	var endOctet = trimValue(end);
	var startOctet;

	if (!validIPv4(start) || !/^\d+$/.test(endOctet))
		return false;

	endOctet = +endOctet;
	startOctet = +trimValue(start).split('.')[3];

	return endOctet >= 0 && endOctet <= 255 && startOctet <= endOctet;
}

function validTarget(value) {
	var match;

	if (validIPv4(value))
		return true;

	match = value.match(/^([^-]+)-(.+)$/);
	if (match && (validIPv4Range(match[1], match[2]) || validIPv4ShortRange(match[1], match[2])))
		return true;

	match = value.match(/^([^/]+)\/(\d+)$/);
	if (match && validIPv4(match[1]) && +match[2] <= 32)
		return true;

	return validMac(value);
}

function looksLikeBadMac(value) {
	var hex = trimValue(value).replace(/[^0-9a-f]/ig, '');

	return hex.length == 12 && value.indexOf(':') == -1;
}

function validateTarget(section_id, value) {
	value = normalizeTarget(value);

	if (value == '')
		return _('IP/MAC required');

	if (validTarget(value))
		return true;

	if (looksLikeBadMac(value))
		return _('MAC address must use colon-separated format');

	return _('Please enter a valid IPv4, CIDR, IP range (192.168.10.100-200), or MAC address');
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

	value = trimValue(value);

	if (value == '')
		return _('Please enter time in HH:MM format');

	if (!validTime(value))
		return _('Please enter time in HH:MM format');

	timestart = (option.option == 'timestart') ? value : optionFormValue(option.map, 'timestart', section_id);
	timeend = (option.option == 'timeend') ? value : optionFormValue(option.map, 'timeend', section_id);

	if (validTime(timestart) && validTime(timeend) &&
	    timeToMinutes(timestart) >= timeToMinutes(timeend))
		return _('Start control time must be earlier than stop control time');

	return true;
}

function validateMinutes(section_id, value) {
	value = trimValue(value);

	return (/^\d+$/.test(value))
		? true
		: _('Please enter a non-negative integer');
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

		m = new form.Map(CONFIG, _('Internet time control'),
			_('Users can limit their internet usage time through MAC and IP, with available IP ranges such as 192.168.10.100-200,Managed devices will be unable to access the soft router\'s administrative interface!') +
			'<br />' +
			_('Set viewing or rest time to 0 to block for the whole start and stop time range. When both are greater than 0, the viewing and rest loop runs only inside that range; outside it, no control is applied.'));

		s = m.section(form.TypedSection, MAIN_SECTION);
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Timecontrol switch'));
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

		o = s.option(form.Value, 'watchtime', _('Viewing time(minute)'));
		o.editable = true;
		o.placeholder = '0';
		o.default = '0';
		o.rmempty = false;
		o.width = '6em';
		o.validate = validateMinutes;

		o = s.option(form.Value, 'resttime', _('Rest time(minute)'));
		o.editable = true;
		o.placeholder = '0';
		o.default = '0';
		o.rmempty = false;
		o.width = '6em';
		o.validate = validateMinutes;

		o = s.option(form.Value, 'timestart', _('Start control time'));
		o.editable = true;
		o.placeholder = '00:00';
		o.default = '00:00';
		o.rmempty = false;
		o.width = '7em';
		o.validate = function(section_id, value) {
			return validateTimePair(this, section_id, value);
		};

		o = s.option(form.Value, 'timeend', _('Stop control time'));
		o.editable = true;
		o.placeholder = '23:59';
		o.default = '23:59';
		o.rmempty = false;
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
