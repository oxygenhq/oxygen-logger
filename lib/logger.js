"use strict";

// set up distributed logging before everything else
var npmlog = global._global_npmlog = require('npmlog');
// npmlog is used only for emitting, we use winston for output
npmlog.level = "silent";

var winston = require('winston')
  , fs = require('fs')
  , os = require('os')
  , path = require('path')
  , util = require('util');
require('date-utils');


var levels = {
  debug: 1
, info: 2
, warn: 3
, error: 4
};

var colors = {
  info: 'cyan'
, debug: 'grey'
, warn: 'yellow'
, error: 'red'
};

var npmToWinstonLevels = {
  silly: 'debug'
, verbose: 'debug'
, info: 'info'
, http: 'info'
, warn: 'warn'
, error: 'error'
};

var timeZone = null;
var stackTrace = null;

// capture any logs emitted by other packages using our global distributed
// logger and pass them through winston
npmlog.on('log', function (logObj) {
  var winstonLevel = npmToWinstonLevels[logObj.level] || 'info';
  var msg = logObj.message && logObj.prefix ?
              (logObj.prefix + ": " + logObj.message) :
              (logObj.prefix || logObj.message);
  global.logger[winstonLevel](msg);
});

var timestamp = function () {
  var date = new Date();
  if (!timeZone) {
    date = new Date(date.valueOf() + date.getTimezoneOffset() * 60000);
  }
  return date.toFormat("YYYY-MM-DD HH24:MI:SS:LL");
};

// Strip the color marking within messages.
// We need to patch the transports, because the stripColor functionality in
// Winston is wrongly implemented at the logger level, and we want to avoid
// having to create 2 loggers.
function applyStripColorPatch(transport) {
  var _log = transport.log.bind(transport);
  transport.log = function (level, msg, meta, callback) {
    var code = /\u001b\[(\d+(;\d+)*)?m/g;
    msg = ('' + msg).replace(code, '');
    _log(level, msg, meta, callback);
  };
}

var _createConsoleTransport = function (args, logLvl) {
  var transport = new (winston.transports.Console)({
    name: "console"
    , timestamp: args.logTimestamp ? timestamp : undefined
    , colorize: !args.logNoColors
    , handleExceptions: true
    , exitOnError: false
    , json: false
    , level: logLvl
  });
  if (args.logNoColors) applyStripColorPatch(transport);
  return transport;
};

var _createFileTransport = function (args, logLvl) {
  var filename = args.log;
  if (filename !== null) {
    // replace env variables for Windows platform
    var platform = require('os').platform();
    if (platform === 'win32') {
      filename = filename.replace(/%([^%]+)%/g, function(key) { 
        return process.env[key.substring(1, key.length-1)]; 
      });
    } else if (platform === 'linux' || platform === 'darwin') {
       filename = filename.replace(/\$([^\$|/]+)\//g, function(key) { 
        return process.env[key.substring(1, key.length-1)]; 
      });
    }
        
    // create the log dir if necessary
    var path = require('path').dirname(filename);
    try {
      fs.mkdirSync(path);
    } catch(e) {
      if (e.code != 'EEXIST') throw e;
    }
  }
  var transport = new (winston.transports.File)({
      name: "file"
      , timestamp: timestamp
      , filename: filename
      , maxFiles: 1
      , handleExceptions: true
      , exitOnError: false
      , json: false
      , level: logLvl
    }
  );
  applyStripColorPatch(transport);
  return transport;
};

var _createLogstashTransport = function(config) {
	require('winston-logstash');
	var transport = new (winston.transports.Logstash) ({
       port: config.port,
       ssl_enable: config.sslEnable,
       host: config.host,
       max_connect_retries: config.max_connect_retries || null,
	   timeout_connect_retries: config.timeout_connect_retries || null,
       meta: {
		location: config.locationName,
		deployment: config.deployment
		},
       node_name: config.node_name || 'agent007',
	   level: config.level || 'error'
    });
	transport.on('error', function(err) {
		console.error('Logstash error occured: ' + err);
	});
	//applyStripColorPatch(transport);
	return transport;
};

var _createWebhookTransport = function (args, logLvl) {
  var host = null,
      port = null;

  if (args.webhook.match(':')) {
    var hostAndPort = args.webhook.split(':');
    host = hostAndPort[0];
    port = parseInt(hostAndPort[1], 10);
  }

  var transport = new (winston.transports.Webhook)({
    name: "webhook"
    , host: host || '127.0.0.1'
    , port: port || 9003
    , path: '/'
    , handleExceptions: true
    , exitOnError: false
    , json: false
    , level: logLvl
  });
  applyStripColorPatch(transport);
  return transport;
};

var _createTransports = function (args) {
  var transports = [];
  var consoleLogLevel = null,
      fileLogLevel = null;

  if (args.loglevel && args.loglevel.match(":")) {
    // --log-level arg can optionally provide diff logging levels for console and file  separated by a colon
    var lvlPair = args.loglevel.split(':');
    consoleLogLevel =  lvlPair[0] || consoleLogLevel;
    fileLogLevel = lvlPair[1] || fileLogLevel;
  } else {
    consoleLogLevel = fileLogLevel = args.loglevel;
  }

  transports.push(_createConsoleTransport(args, consoleLogLevel));
  if (args.log) {
    try {
      // if we don't delete the log file, winston will always append and it will grow infinitely large;
      // winston allows for limiting log file size, but as of 9.2.14 there's a serious bug when using
      // maxFiles and maxSize together. https://github.com/flatiron/winston/issues/397
      if (fs.existsSync(args.log)) {
        fs.unlinkSync(args.log);
      }

      transports.push(_createFileTransport(args, fileLogLevel));
    } catch (e) {
      console.log("Tried to attach logging to file " + args.log +
                  " but an error occurred: " + e.msg);
    }
  }
  if (args.logstash) {
	  try {
		  transports.push(_createLogstashTransport(args.logstash));
	  }
	  catch (e) {
		  console.log("Tried to attach logging to Logstash " + args.logstash +
                  " but an error occurred: " + e);
	  }
  }
  if (args.webhook) {
    try {
      transports.push(_createWebhookTransport(args, fileLogLevel));
    } catch (e) {
      console.log("Tried to attach logging to webhook at " + args.webhook +
                  " but an error occurred. " + e.msg);
    }
  }

  return transports;
};

var _appDir = path.dirname(require.main.filename);

var _stackToString = function (stack) {
  var str = os.EOL + "    [------TRACE------]" + os.EOL;
  var len = stack.length < 15 ? stack.length : 15;

  for (var i = 0; i < len; i++) {
      var fileName = stack[i].getFileName();
      // ignore calls from this file
      if (fileName === __filename) continue;
      var substr = "    at ";
    try {
      var typeName = stack[i].getTypeName();

      substr += util.format("%s.%s (%s:%d:%d)" + os.EOL, typeName, stack[i].getFunctionName(),
                  path.relative(_appDir, stack[i].getFileName()), stack[i].getLineNumber(),
                  stack[i].getColumnNumber());
      str += substr;

    } catch (e) { }
  }

  return str;
};

var _addStackTrace = function (fn, stackTrace) {
  var _fn = fn;
  return function (msg) {
    _fn(msg + os.EOL + _stackToString(stackTrace.get()) + os.EOL);
  };
};
var _wrapLoggerWithPrefix = function (prefix) {
	if (!global.logger) return null;
	var wrapper = {};
	Object.keys(global.logger.levels).forEach(function (level) {
		wrapper[level] = function (msg) {
			// build argument list (level, msg, ... [string interpolate], [{metadata}], [callback])
			console.log('logging...');
			var args = Array.prototype.slice.call(arguments);
			if (args.length > 0)
				args[0] = '[' + prefix + '] ' + args[0];
			try {
				global.logger[level].apply(undefined, args);
			}
			catch (e) {}	// ignore any error
		};
	});
	return wrapper; //wrapper.info = function (msg) { logger.info('[' + prefix + '] ' + msg); };
};

module.exports.init = function (args) {
	if (!args) args = {};
  // check if logger factory has been already initialized (usually by the first caller)
  if (global._loggerInitialized) {
	  console.log('logger already initialized');
	return;
  }
  // set de facto param passed to timestamp function
  timeZone = args.localTimezone;

  // by not adding colors here and not setting 'colorize' in transports
  // when logNoColors === true, console output is fully stripped of color.
  if (!args.logNoColors) {
    winston.addColors(colors);
  }

  global.logger = new (winston.Logger)({
    transports: _createTransports(args)
  });

  global.logger.setLevels(levels);

  // 8/19/14 this is a hack to force Winston to print debug messages to stdout rather than stderr.
  // TODO: remove this if winston provides an API for directing streams.
  if (levels[global.logger.transports.console.level] === levels.debug) {
    global.logger.debug = function (msg) { global.logger.info('[debug] ' + msg); };
  }

  if (args.asyncTrace) {
    stackTrace = require('stack-trace');
    global.logger.info = _addStackTrace(global.logger.info, stackTrace);
    global.logger.warn = _addStackTrace(global.logger.warn, stackTrace);
    global.logger.error = _addStackTrace(global.logger.error, stackTrace);
  }
  global._loggerInitialized = true;
};

module.exports.get = function (prefix) {
  if (global.logger === null) {
    exports.init({});
  }
  if (prefix)
	  return _wrapLoggerWithPrefix(prefix);
  return global.logger;
};
