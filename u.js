
var log = console.log;

function errx(rc, err)
{
  var msg;
  if (typeof (err) === 'string')
    msg = err;
  else
    msg = err.message;

  if (rc === 0) 
    log('\nDONE: ' + msg + '\n');
  else
    log('\nERROR [' + rc + ']: ' + msg + '\n');

  process.exit(rc);
}

exports.errx = errx;
