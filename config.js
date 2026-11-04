const storage = require('./lib/storage');
const saved = storage.readJSON('config.json', {});
module.exports = {
  backendBaseUrl: process.env.WATCHRSS_URL || saved.backendBaseUrl || 'https://sly-data-plane.watchrss.cn',
  supabaseAnonKey: process.env.WATCHRSS_ANON_KEY || saved.supabaseAnonKey || '',
  appVersionHeader: 'cli-0.2.0',
};
