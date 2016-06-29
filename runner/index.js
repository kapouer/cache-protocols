var spawn = require('child_process').spawn;
var express = require('express');
var http = require('http');
var fs = require('fs');
var URL = require('url');
var Transform = require('stream').Transform;
var util = require('util');

process.chdir(__dirname);

module.exports = function(opts) {
	var obj = {};
	obj.close = close.bind(obj);
	process.on('exit', obj.close);
	if (opts.express) {
		obj.express = express();
		obj.express.server = obj.express.listen(opts.express.port);
	}
	if (opts.memcached) {
		obj.memcached = spawn('memcached', ['-vv', '-p', opts.memcached.port]);
		obj.memcached.stdout.pipe(process.stdout);
		obj.memcached.stderr.pipe(new FilterPipe(function(str) {
			if (/^\<\d+\s[sg]et\s.*$/mig.test(str)) return "[memc] " + str.substring(4);
		})).pipe(process.stderr);
		obj.memcached.on('error', obj.close);
	}
	if (opts.nginx) {
		var conf = fs.readFileSync(opts.nginx.conf).toString();
		if (opts.memcached) conf = conf.replace(/\$memcached/g, opts.memcached.port);
		if (opts.express) conf = conf.replace(/\$express/g, opts.express.port);
		conf = conf.replace(/\$nginx/g, opts.nginx.port);

		fs.writeFileSync('../test/temp.conf', conf);

		obj.nginx = spawn('/usr/sbin/nginx', [
			'-p', __dirname,
			'-c', './index.conf'
		]);
		obj.nginx.stdout.pipe(process.stdout);
		obj.nginx.stderr.pipe(new FilterPipe(function(str) {
			str = str.replace(/^nginx: \[alert\] could not open error log file: open.*/, "");
			str = str.replace(/^.*(\[\w+\]).*?:(.*)$/, function(str, p1, p2) {
				if (p1 == "[notice]") return "";
				return p1 + p2;
			});
			str = str.replace(/^\[lua\][\d\):]*\s/, "[lua]  ");
			return str;
		})).pipe(process.stderr);
		obj.nginx.on('error', obj.close);
	}
	return obj;
};

function close() {
	if (this.nginx) {
		this.nginx.kill('SIGTERM');
		delete this.nginx;
	}
	if (this.memcached) {
		this.memcached.kill('SIGKILL');
		delete this.memcached;
	}
	if (this.express) {
		this.express.server.close();
		delete this.express;
	}
}

module.exports.get = function(uri) {
	return new Promise(function(resolve, reject) {
		http.get(uri, function(res) {
			var body = "";
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				body += chunk;
			});
			res.on('end', () => {
				res.body = JSON.parse(body);
				resolve(res);
			});
		}).once('error', function(err) {
			reject(err);
		});
	});
};

module.exports.post = function(uri, data) {
	return new Promise(function(resolve, reject) {
		var uriObj = URL.parse(uri);
		uriObj.method = 'POST';
		var req = http.request(uriObj, function(res) {
			resolve(res);
		});
		req.once('error', function(err) {
			reject(err);
		});
		req.write(data);
		req.end();
	}).catch(function(err) {
		console.error(err);
	});
};

function FilterPipe(matcher) {
	Transform.call(this);
	this.matcher = matcher;
}
util.inherits(FilterPipe, Transform);
FilterPipe.prototype._transform = function(chunk, enc, cb) {
	var lines = [];
	chunk.toString().split('\n').forEach(function(str) {
		str = this.matcher(str);
		if (str) lines.push(str);
	}.bind(this));
	if (lines.length) lines.push('');
	this.push(lines.join('\n'));
	cb();
};

