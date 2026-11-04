module.exports={checkCurrent(){if(!require('./account').getUsableSession())throw Object.assign(Error('请先登录'),{code:'login_required'});}};
