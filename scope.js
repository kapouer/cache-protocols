var jwt = require('jsonwebtoken');
var cookie = require('cookie');
var debug = require('debug')('upcache:scope');

module.exports = function(obj) {
	return new Scope(obj);
};

function Scope(obj) {
	this.publicKeySent = false;
	this.config = Object.assign({
		algorithm: 'RS256',
		forbidden: function(res) {
			res.sendStatus(403);
		},
		unauthorized: function(res) {
			res.sendStatus(401);
		}

	}, obj);
}

Scope.headerHandshake = 'X-Cache-Key-Handshake';
Scope.headerScope = 'X-Cache-Scope';

// facility for checking request against some scopes
Scope.prototype.allowed = function(req) {
	var action = getAction(method);
	var list = restrictionsByAction(action, Array.from(arguments).slice(1));
	sendHeaders(req.res, list);
	return authorize(action, list, this.parseBearer(req));
};

function restrictionsByAction(action, list) {
	if (!action) return [];
	if (!Array.isArray(list)) list = [list];
	var metaAction = action == "read" ? "read" : "write";
	var restrictions = [];
	list.forEach(function(item) {
		if (typeof item != "string") {
			if (item[action]) item = item[action];
			else if (item[metaAction]) item = item[metaAction];
			else return;
		}
		restrictions.push(item);
	});
	return restrictions;
}

function authorize(action, restrictions, user) {
	if (!action) return false;
	var failure = false;
	var scopes = user && user.scopes;
	var i, label, grant, scope, mandatory, regstr;
	var grants = [];
	for (i=0; i < restrictions.length; i++) {
		grant = label = restrictions[i];
		if (label == "*") {
			grants.push(grant);
			continue;
		}
		if (!scopes) continue;
		mandatory = false;
		if (label[0] == "&") {
			mandatory = true;
			label = label.substring(1);
		}
		regstr = label.replace(/\*/g, '.*');
		if (regstr.length != label.length) {
			// wildcard
			var reg = new RegExp("^" + regstr + "$");
			if (Object.keys(scopes).some(function(scope) {
				var scopeObj = scopes[scope];
				if (scopeObj == true || scopeObj != null && scopeObj[action] == true) {
					return reg.test(scope);
				}
			})) {
				grants.push(grant);
				continue;
			}
		} else {
			scope = scopes[label];
			if (scope === true || scope && scope[action]) {
				grants.push(grant);
				continue;
			}
		}
		if (mandatory) {
			failure = true;
			break;
		}
	}
	if (failure || !grants.length) return false;
	// might be useful for optimizing first proxy response key
	// by sending actual scopes being granted, since the response key
	// will do the same job, given request bearer and restrictions list
	return grants;
}

function sendHeaders(res, list) {
	// an empty list does not have same meaning as no list at all
	if (list) {
		res.set(Scope.headerScope, list);
		debug("send header", Scope.headerScope, list);
	} else {
		debug("not sending header", Scope.headerScope);
	}
};

Scope.prototype.restrict = function() {
	var restrictions = Array.from(arguments);
	var config = this.config;
	var self = this;
	// TODO memoize restrictionsByAction
	return function(req, res, next) {
		if (req.get(Scope.headerHandshake) == '1' || !self.publicKeySent) {
			debug("sending public key to proxy");
			self.publicKeySent = true;
			res.set(Scope.headerHandshake, encodeURIComponent(config.publicKey));
		}
		var user = self.parseBearer(req);
		var action = getAction(req.method);
		var list = restrictionsByAction(action, restrictions);
		sendHeaders(res, list);
		var grants = authorize(action, list, user);
		if (grants) {
			debug("grants", grants);
			next();
		} else if (!user || !user.scopes) {
			config.unauthorized(res);
		} else {
			config.forbidden(res);
		}
	};
};

Scope.prototype.login = function(res, user, opts) {
	if (!user.scopes) debug("login user without scopes");
	opts = Object.assign({}, this.config, opts);
	var bearer = jwt.sign(user, opts.privateKey, {
		expiresIn: opts.maxAge,
		algorithm: opts.algorithm,
		issuer: opts.issuer
	});
	if (res) res.cookie('bearer', bearer, {
		maxAge: opts.maxAge * 1000,
		httpOnly: true,
		path: '/'
	});
	return bearer;
};

Scope.prototype.logout = function(res) {
	res.clearCookie('bearer', {
		httpOnly: true,
		path: '/'
	});
};

function getAction(method) {
	return {
		GET: "read",
		HEAD: "read",
		PUT: "save",
		PATCH: "save",
		POST: "add",
		DELETE: "del"
	}[method];
}

Scope.prototype.parseBearer = function(req) {
	var config = this.config;
	var prop = config.userProperty;
	if (prop && req[prop]) return req[prop];
	if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || "") || {};

	var bearer = req.cookies.bearer;
	if (!bearer) {
		return;
	}
	var obj;
	try {
		obj = jwt.verify(bearer, config.publicKey, {
			algorithm: config.algorithm,
			issuer: config.issuer
		});
	} catch(ex) {
		debug(ex, bearer);
	}
	if (!obj) return;
	if (prop) req[prop] = obj;
	return obj;
};
