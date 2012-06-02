#!/usr/bin/env node


var path = require('path');
var fs = require('fs');
var $ = require('async');
var log = console.log;
var errx = require('./u').errx;
var argv = require('optimist').
  string('f').describe('f', 'Load a particular Makefile').
  boolean('e').describe('e', 'Environment variables override assignments within makefiles').
  argv;

var MAKE = {
  name: 'MAKE',
  value: process.argv[0] + ' ' + process.argv[1],
  environment: true
};

var C = {
  implicit: '/usr/share/lib/make/make.rules',
  overenv: false,
  makefile: null
};

var M = { MAKE: MAKE }; // Macros
var T = {}; // Targets
var CM = {}; // Conditional Macros

function readMakeFlags(cb)
{
  if (process.env.MAKEFLAGS === 'e')
    C.overenv = true;
  else if (process.env.MAKEFLAGS)
    return cb('MAKEFLAGS not yet implemented');
  cb();
}

function readMakeArgs(cb)
{
  if (argv.f) {
    if (argv.f === '-') // XXX optimist doesn't accept - as a string arg :(
      return cb('stdin Makefile not yet implemented');
    C.makefile = argv.f;
  }
  if (argv.e) {
    C.overenv = true;
  }
  cb();
}

function findMakeFile(cb)
{
  if (!C.makefile) {
    if (path.existsSync('makefile'))
      C.makefile = 'makefile';
    else
      C.makefile = 'Makefile';
  }
  readMakeFile(C.makefile, cb);
}

function readMakeFile(f, cb)
{
  if (!path.existsSync(f))
    return cb('could not find ' + f);

  var lines = fs.readFileSync(f, 'utf8').split('\n');
  parseMakeFile(f, lines, cb);
}

// XXX TODO this should be CPS to allow for :sh ...
function expandSubstring(str, cb)
{
  if (!str.match(/[:%]/)) {
    // lookup as a MACRO
    if (M[str])
      return expandString(M[str].value, cb);
      //cb(null, M[str].value);
    return cb(null, '');
  }
  return cb(null, '$(' + str + ')');
}

function expandStringImpl(s, cb)
{
  while (s.pos < s.inp.length) {
    var c = s.inp.charAt(s.pos);
    switch (s.state) {
      case 'REST':
        switch (c) {
          case '\\':
            s.state = 'ESCAPE';
            break;
          case '$':
            s.state = 'DOLLAR';
            break;
          //case '#':
           // s.state = 'COMMENT';
            //break;
          default:
            s.out += c;
        }
        break;
      case 'ESCAPE':
        switch (c) {
          case '$':
          case '\\':
            s.out += c;
            break;
          default:
            s.out += '\\' + c;
            break;
        }
        s.state = 'REST';
        break;
      case 'DOLLAR':
        switch (c) {
          case '(':
            s.parens++;
            s.state = 'SUBSTRING';
            break;
          case '$':
            s.out += '$';
            s.state = 'REST';
            break;
          default:
            return cb('PARSE ERROR ONE!');
        }
        break;
      case 'SUBSTRING':
        switch (c) {
          case '(':
            s.parens++;
            s.sub += c;
            break;
          case ')':
            s.parens--;
            if (s.parens === 0) {
              return expandSubstring(s.sub, function(err, str) {
                s.out += str;
                s.sub = '';
                s.state = 'REST';
                s.pos++;
                return cb();
              });
              //s.out += expandSubstring(s.sub);
              //s.sub = '';
              //s.state = 'REST';
            } else {
              s.sub += c;
            }
            break;
          default:
            s.sub += c;
        }
      case 'COMMENT':
        break;
      default:
        return cb('unexpected state: ' + s.state);
    }
    s.pos++;
  }

  if (s.state !== 'COMMENT' && s.state !== 'REST')
    return cb('line finished on ' + s.state + ', not on REST: ' + s.inp);

  s.state = 'DONE';
  cb();
}

function expandString(str, cb)
{
  var s = {
    state: 'REST',
    inp: str,
    pos: 0,
    sub: '',
    out: '',
    parens: 0
  };
  // prevent a deep call stack explosion:
  process.nextTick(function() {
    $.until(function() { return s.state === 'DONE' },
      $.apply(expandStringImpl, s), function(err) {
        log('EXP: ' + str + ' -> ' + s.out);
        if (err) errx(5, err);
        cb(null, s.out);
      });
  });
}

function parseMakeFile(filename, lines, cb)
{
  var l = 0;
  var inflight = null;
  var target = null;
  var q = $.queue(function(line, cb) {
    l++;

    var m = line.match(/^(.*)[ \t]*\\$/);
    if (m) {
      log('&& CONT && ' + m[1]);
      // line with continuation character
      inflight = (inflight === null ? m[1].trimRight() : inflight + ' ' + m[1].trim());
      return cb();
    }

    if (inflight !== null) {
      line = inflight + ' ' + line.trim();
      inflight = null;
    }

    if (line.charAt(0) === '#')
      return cb(); // comment line

    log('#LINE# ' + line);

    var m = line.match(/^include[ \t]+(.*)$/);
    if (m) { // include line
      return expandString(m[1], function(err, str) {
        if (err) errx(50, err);
        log('### [' + filename + ':' + l + '] ' + 'INCLUDE: ' + str);
        readMakeFile(str, cb);
      });
    }

    var m = line.match(/^\t+(.*)$/);
    if (m) {
      if (target !== null)
        target.rules.push(m[1]);
      else
        errx(59, 'parse error: unexpected rule');
      return cb();
    }

    // if we're not appending rules to an existing target
    //   and we have one, then commit the old one
    if (target !== null) {
      log('### [' + filename + ':' + l + '] ' + 'END TARGET: ' + target.name);
      var targs = target.name.trim().split(/[ \t]+/);
      targs.forEach(function (x) {
        log('### [' + filename + ':' + l + '] ' + 'COMMIT TARGET: ' + x);
        if (T[x]) {
          target.deps.forEach(function(z) { T[x].deps.push(z); });
          target.rules.forEach(function(z) { T[x].rules.push(z); });
        }
        T[x] = target;
      });
      target = null;
    }

    var m = line.match(/^([^+:=]+):([^=]*)$/);
    if (m) { // TARG TARG TARG: DEP DEP DEP
      log('%% EXPAND 1 %% ' + m[1]);
      return expandString(m[1], function(err, str) {
        var targs = str.trim();
        log('%% EXPAND 2 %% ' + m[2]);
        expandString(m[2], function(err, str) {
          var deps = str.trim().split(/[ \t]+/).filter(function(x) { return x !== '' });
          log('### [' + filename + ':' + l + '] ' + 'TARGET DEF: ' + targs + ': ' + deps);
          target = {
            name: targs,
            deps: deps,
            rules: []
          };
          return cb();
        });
      });
    }

    var m = line.match(/^([^+:= \t]?[^+:=]+)[ \t]*:=[ \t]+(.*)[ \t]*$/);
    if (m) {
      return expandString(m[1], function(err, str) {
        var cond = str.trim().split(/[ \t]+/);
        var xxxx = m[2].trim().split('=');
        var macname = xxxx[0].trim();
        var macval = xxxx[1].trim();
        cond.forEach(function (cone) {
          log('### CONDITIONAL MACRO (' + cone + ') --> ' + xxxx);
           if (!CM[cone]) {
             CM[cone] = {
               name: cone,
               macros: {}
             };
           }
           CM[cone].macros[macname] = macval;
        });
        return cb();
      });
    }

    var m = line.match(/^([^+:= \t]?[^+:=]+)[ \t]+\+=[ \t]+(.*)[ \t]*$/);
    if (m) {
      return expandString(m[1], function(err, str) {
        var name = str.trim();
        var xval = m[2].trim();
        // XXX should check that expanded macro name is valid
        if (M[name]) {
          if (!C.overenv || M[name].environment === false) {
            log('### ADDITIVE SET (' + name + ') --> ' + xval);
            M[name].value += ' ' + xval;
          } else {
            log('### IGNORE ADDITIVE SET (' + name + ') --> ' + xval);
            log('### INSTEAD, ENV: ' + name + '= ' + M[name].value);
          }
        } else {
          M[name] = {
            name: name,
            value: xval,
            environment: false
          };
        }
        return cb();
      });
    }

    var m = line.match(/^([^+:= \t]?[^+:=]+)[ \t]*=[ \t]*(.*)[ \t]*$/);
    if (m) { // MACRO= value
      return expandString(m[1], function(err, str) {
        var name = str.trim();
        var val = m[2].trim();
        if (name.match(/^#/)) {
          log('### [' + filename + ':' + l + '] ' + 'COMMENT SET: ' + name + '= ' + val);
          return cb();
        }
        if (M[name]) {
          if (!C.overenv || M[name].environment === false) {
            log('### [' + filename + ':' + l + '] ' + 'SET: ' + name + '= ' + val);
            M[name].value = val;
          } else {
            log('### [' + filename + ':' + l + '] ' + 'IGNORE SET: ' + name + '= ' + val);
            log('### [' + filename + ':' + l + '] ' + 'INSTEAD, ENV: ' + name + '= ' + M[name].value);
          }
        } else {
          log('### [' + filename + ':' + l + '] ' + 'SET: ' + name + '= ' + val);
          M[name] = {
            name: name,
            value: val,
            environment: false
          };
        }
        cb();
      });
    }

    if (line.trim() !== '')
      log('#WHAT# ' + line);
    cb();
  }, 1);
  q.drain = cb;
  var qcb = function(err) {
    if (err) {
      q.concurrency = 0;
      return cb(err);
    }
  };
  q.push(lines, qcb);
}

var ieRun = 0;
function importEnvironment(cb)
{
  ieRun++;
  if (ieRun < 1)
    return cb('unexpected value ' + run);

  // if -e specified, we want to import the environment
  //   *after* reading the Makefiles.  if no -e, then
  //   we only want to import it once, up front.
  // XXX if ((C.overenv && ieRun === 1) || (!C.overenv && ieRun > 1))
  // if (!C.overenv && ieRun > 1)
    //return cb();

  for (var k in process.env) {
    switch (k) {
      case 'HOST_ARCH':
      case 'HOST_MACH':
      case 'TARGET_MACH':
      case 'MAKEFLAGS':
      case 'SHELL':
      case '_':
        break;
      default:
        if (M[k]) {
          M[k].value = process.env[k];
          M[k].environment = true;
        } else {
          M[k] = {
            name: k,
            value: process.env[k],
            environment: true
          };
        }
    }
  }

  cb();
}

function exportEnvironment(cb)
{
  for (var k in M) {
    if (M.hasOwnProperty(k)) {
      var m = M[k];
      if (m.environment === true)
        process.environment[k] = m.value;
    }
  }
  cb();
}

function readMakeArgsMacros(cb)
{
  // XXX TODO read MACRO=defn from argv._
  cb();
}

function dumpMacros(cb)
{
  log('\n\n################################################');
  log(    '##################### MACROS ###################');
  log(    '################################################\n\n');
  log('\n\n');
  var x = [];
  Object.keys(M).sort().forEach(function (name) {
    var macro = M[name];
    if (macro.value !== '')
      log(name + '= ' + macro.value);
  });
  log('');
  Object.keys(CM).sort().forEach(function (name) {
    var target = CM[name];
    Object.keys(target.macros).sort().forEach(function(macname) {
      log(name + ' := ' + macname + ' = ' + target.macros[macname]);
    });
  });
  cb();
}

function dumpTargets(cb)
{
  log('\n\n################################################');
  log(    '#################### TARGETS ###################');
  log(    '################################################\n\n');
  var x = [];
  for (var k in T) {
    if (T.hasOwnProperty(k)) {
      var m = T[k];
      x.push(k + ': ' + m.deps.join(' ') + '\n\t' + m.rules.join('\n\t'));
    }
  }
  log(x.sort().join('\n'));
  cb();
}

function pad(len)
{
  var s = '';
  while (s.length < len * 3)
    s += ' ';
  return s;
}

function doThing(x, depth, cb)
{
  if (!depth) depth = 1;

  if (x === '.WAIT')
    return cb();

  var targ = T[x];

  log(pad(depth) + ' --> ' + x);
  var cmac = CM[x];
  if (cmac) {
    Object.keys(cmac.macros).sort().forEach(function(cm) {
      log(pad(depth) + '      \\ ' + cm + '= ' + cmac.macros[cm]);
    });
  }

  if (!targ)
    errx(5, 'dont know how to build target: ' + x);

  var depq = $.queue(function(dep, cb) {
    doThing(dep, depth + 1, cb);
  }, 1);
  depq.drain = function() {
    var ruleq = $.queue(function(rule, cb) {
      return expandString(rule, function(err, str) {
        log(pad(depth) + '      : ' + str);
        cb();
      });
    }, 1);
    ruleq.drain = function() {
      log(pad(depth) + ' <-- ' + x);
      cb();
    };
    ruleq.push(targ.rules);
    if (ruleq.length() === 0) cb();
  };
  depq.push(targ.deps);
  if (depq.length() === 0) cb();
}

function doThings(cb)
{
  log(CM);
  if (!argv._ || argv._.length < 1) return cb();

  log('\n\n\nTHINGS: ' + argv._ + '\n');
  var targq = $.queue(function(targ, cb) {
    doThing(targ, 1, cb);
  }, 1);
  targq.drain = function() { cb('done'); };
  argv._.forEach(function (thi) { targq.push(thi); });
  if (targq.length() === 0)
    cb('done');
}

$.series([
  readMakeFlags,
  readMakeArgs,
  $.apply(readMakeFile, C.implicit),
  importEnvironment,
  findMakeFile,
  readMakeArgsMacros,

  doThings,

  dumpMacros,
  dumpTargets
], function end(err) {
  if (err) errx(1, err);
  errx(0, 'finished');
});
