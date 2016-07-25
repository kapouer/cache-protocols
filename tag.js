var debug = require('debug')('upcache:tag');

var headerTag = 'X-Cache-Tag';

module.exports = function() {
	var tags = Array.from(arguments);
	var tagsMap = {};
	tags.forEach(tag => tagsMap[tag] = true);

	return function tagMw(req, res, next) {
		debug("route has tags", tags);
		var reqTags = req.get(headerTag);
		var resTags = res.get(headerTag) || [];
		if (reqTags) reqTags.split(',').forEach(function(tag) {
			tag = tag.trim();
			if (!tagsMap[tag]) resTags.push(tag);
		});
		resTags = resTags.concat(tags);

		// unicode string comparison
		resTags.sort();

		if (req.method != "GET") resTags = resTags.map(function(tag) {
			return '+' + tag;
		});
		debug("response tags", resTags);
		if (resTags.length) res.set(headerTag, resTags);
		next();
	};
};

