// CLI has no UI timer/watchdog. Keep shared codec task boundaries synchronous.
module.exports={run:(_name,_bytes,work)=>work(),mark(){},instrument(){}};
