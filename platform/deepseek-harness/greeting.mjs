/** Only the authenticated owner endpoint carries the owner's reported app locale. */
export function greetingOwner(profile,expectedId){
 if(profile?.id!==expectedId||typeof profile.nickname!=='string'||!profile.nickname.trim())throw new Error('ClawChat owner profile is unavailable or mismatched');
 let locale=null;
 if(typeof profile.locale==='string'&&profile.locale.trim()){
  try{locale=Intl.getCanonicalLocales(profile.locale.trim().replaceAll('_','-'))[0]??null;}catch{}
 }
 return {id:profile.id,nickname:profile.nickname.trim(),locale:locale??"en",localeSource:locale?"owner-profile":"default"};
}
export function greetingPrompt(owner,guidance){
 const language=owner.locale?'. Reply in the owner app language: '+JSON.stringify(owner.locale)+'.':'. The owner has not reported a language; do not assume Chinese or English from missing metadata.';
 return 'Write a brief initial greeting to the owner. Do not use tools. Owner nickname: '+JSON.stringify(owner.nickname)+language+' Follow this greeting guidance: \n'+guidance;
}
export function reusableGreetingDraft(draft,owner){
 if(draft?.ownerId&&draft.ownerId!==owner.id)throw new Error('Greeting owner identity mismatch');
 if(draft?.status==='complete'&&!draft.deliveryStarted&&(draft.locale!==owner.locale||draft.ownerId!==owner.id))return null;
 return draft;
}
