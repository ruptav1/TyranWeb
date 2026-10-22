'use strict';
// Startup timings while developing (TYRAN_TIMING=1): each mark logged as the milliseconds since the
// process started (and once, when that was, to line them up with the pages' performance marks).
const on = !!process.env.TYRAN_TIMING;
if (on) console.log(`[timing] process-start-epoch ${Math.round(Date.now() - process.uptime() * 1000)}`);
module.exports = (label) => on && console.log(`[timing] ${label} ${Math.round(process.uptime() * 1000)}`);
