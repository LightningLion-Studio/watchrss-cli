const storage=require('./storage');
// Cooperative CPU work shares the UI thread. Check input quiet time between
// small batches, and fence each continuation to its original account/directory.
function owner(){const s=require('./account').getUsableSession();return storage.root+'\n'+(s?s.userId+'\n'+s.accessToken:'');}
async function run(iterator){
 const expected=owner();await require('./cooperative').turn();const value=await require('./cooperative').run(iterator,'background.batch',()=>{if(owner()!==expected)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});},()=>{const ui=require('./interaction');return ui.whenIdle?ui.whenIdle():undefined;});await require('./cooperative').turn();if(owner()!==expected)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});return value;
}
function drain(iterator){let result;while(!(result=iterator.next()).done){if(result.value&&result.value.__backgroundTask)result.value.sync();}return result.value;}
module.exports={run,drain};
