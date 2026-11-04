// Source records have one entity clock. Rebase queued field operations onto the
// authenticated server value before replay; otherwise a newer local whole-source
// timestamp can accidentally carry stale unrelated fields through a successful CAS.
function sources(values,intents,library){const ids=new Set(intents.filter(i=>['pin','source-original','order-source','delete-source'].includes(i.type)).map(i=>i.id));for(const value of values)if(ids.has(value.url))library.upsertSource({...value,__syncedSettingsIncluded:true});}
module.exports={sources};
