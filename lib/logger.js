'use strict';

// set up distributed logging before everything else
var npmlog = global._global_npmlog = require('npmlog');
// npmlog is used only for emitting, we use winston for output
npmlog.level = 'silent';

var winston = require('winston'),
    fs = require('fs'),
    os = require('os'),
    path = require('path'),
    util = require('util');
require('date-utils');

var levels = {
    debug: 4,
    info: 3,
    warn: 2,
    error: 1
};

var colors = {
    info: 'cyan',
    debug: 'grey',
    warn: 'yellow',
    error: 'red'
};

var npmToWinstonLevels = {
    silly: 'debug',
    verbose: 'debug',
    info: 'info',
    http: 'info',
    warn: 'warn',
    error: 'error'
};
const DEFAULT_LOG_LEVEL = 'info';
var timeZone = null;
var stackTrace = null;

// capture any logs emitted by other packages using our global distributed
// logger and pass them through winston
npmlog.on('log', function (logObj) {
    var winstonLevel = npmToWinstonLevels[logObj.level] || 'info';
    var msg = logObj.message && logObj.prefix ? (logObj.prefix + ': ' + logObj.message) : (logObj.prefix || logObj.message);
    global.logger[winstonLevel](msg);
});

var timestamp = function () {
    var date = new Date();
    if (!timeZone) {
        date = new Date(date.valueOf() + date.getTimezoneOffset() * 60000);
    }
    return date.toFormat('YYYY-MM-DD HH24:MI:SS:LL');
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
        name: 'console'
        , timestamp: args.logTimestamp ? timestamp : undefined
        , colorize: !args.logNoColors
        // , handleExceptions: true
        // , humanReadableUnhandledException: true
        , exitOnError: false
        , json: false
        , level: logLvl
    });
    if (args.logNoColors) applyStripColorPatch(transport);
    return transport;
};

var _createFileTransport = function (config) {
    var filePath = config.path;
    var logLvl = config.level;
    if (!logLvl) {
        logLvl = DEFAULT_LOG_LEVEL;
    }
    if (!filePath) {
        return null;
    }
    // replace env variables for Windows platform
    var platform = require('os').platform();
    if (platform === 'win32') {
        filePath = filePath.replace(/%([^%]+)%/g, function(key) {
            return process.env[key.substring(1, key.length-1)];
        });
    } else if (platform === 'linux' || platform === 'darwin') {
        filePath = filePath.replace(/\$([^\$|/]+)\//g, function(key) {
            return process.env[key.substring(1, key.length-1)];
        });
    }
    // convert relative path to full path if applicable
    filePath = _resolvePath(filePath, path.dirname(require.main.filename));

    // create the log dir if necessary
    var dirPath = path.dirname(filePath);
    try {
        fs.mkdirSync(dirPath);
    } catch(e) {
        if (e.code != 'EEXIST') throw e;
    }
    // if we don't delete the log file, winston will always append and it will grow infinitely large;
    // winston allows for limiting log file size, but as of 9.2.14 there's a serious bug when using
    // maxFiles and maxSize together. https://github.com/flatiron/winston/issues/397
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    var transport = new (winston.transports.File)({
        name: 'file'
        , timestamp: timestamp
        , filename: filePath
        , maxFiles: 1
        , handleExceptions: true
        , humanReadableUnhandledException: true
        , exitOnError: false
        , json: false
        , level: logLvl});
    applyStripColorPatch(transport);

    return transport;
};

var _createWebhookTransport = function (args, logLvl) {
    var host = null;
    var port = null;

    if (args.webhook.match(':')) {
        var hostAndPort = args.webhook.split(':');
        host = hostAndPort[0];
        port = parseInt(hostAndPort[1], 10);
    }

    var transport = new (winston.transports.Webhook)({
        name: 'webhook'
        , host: host || '127.0.0.1'
        , port: port || 9003
        , path: '/'
        , handleExceptions: true
        , humanReadableUnhandledException: true
        , exitOnError: false
        , json: false
        , level: logLvl
    });
    applyStripColorPatch(transport);
    return transport;
};

var _createTransports = function (args) {
    var transports = [];
    var consoleLogLevel = DEFAULT_LOG_LEVEL;

    if (args.console && args.console.level) {
        consoleLogLevel = args.console.level;
    }

    transports.push(_createConsoleTransport(args, consoleLogLevel));

    if (args.file && args.file.path && args.file.level) {
        try {
            transports.push(_createFileTransport(args.file));
        } catch (e) {
            console.log('Tried to attach logging to file ' + args.log + ' but an error occurred: ' + e.msg);
        }
    }
    if (args.webhook) {
        try {
            transports.push(_createWebhookTransport(args, fileLogLevel));
        } catch (e) {
            console.log('Tried to attach logging to webhook at ' + args.webhook + ' but an error occurred. ' + e.msg);
        }
    }

    return transports;
};

var _appDir = path.dirname(require.main.filename);

var _stackToString = function (stack) {
    var str = os.EOL + '        [------TRACE------]' + os.EOL;
    var len = stack.length < 15 ? stack.length : 15;

    for (var i = 0; i < len; i++) {
        var fileName = stack[i].getFileName();
        // ignore calls from this file
        if (fileName === __filename) 
            continue;
        var substr = '        at ';
        try {
            var typeName = stack[i].getTypeName();

            substr += util.format('%s.%s (%s:%d:%d)' + os.EOL, typeName, stack[i].getFunctionName(),
                path.relative(_appDir, stack[i].getFileName()), 
                stack[i].getLineNumber(), 
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
            var args = Array.prototype.slice.call(arguments);
            if (args.length > 0)
                args[0] = '[' + prefix + '] ' + args[0];
            try {
                global.logger[level].apply(undefined, args);
            } catch (e) {}        // ignore any error
        };
    });
    return wrapper; //wrapper.info = function (msg) { logger.info('[' + prefix + '] ' + msg); };
};

var _resolvePath = function(pathToResolve, baseFolder) {
    if (path.isAbsolute(pathToResolve))
        return pathToResolve;
    return path.resolve(baseFolder, pathToResolve);
};

module.exports.init = function (args) {
    if (!args) 
        args = {};
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
        global.logger.debug = function (msg) { global.logger.info(msg); };
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
