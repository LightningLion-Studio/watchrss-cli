const fs=require('node:fs'),os=require('node:os'),path=require('node:path');process.env.WATCHRSS_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'watchrss-codec-test-'));
