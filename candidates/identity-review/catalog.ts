// Browser-safe catalog: no secrets, identity grants or server dependencies.
export const domains=['IDENTITY','OFFICE','ESCORT','RECRUITMENT','ATTENDANCE','RELEASE','ACCOUNTS','PAYROLL','SETTLEMENT','KNOWLEDGE','SECURITY_GUARD','PERSONAL'] as const;
export const capabilities=['identity.read','identity.propose','identity.verify','identity.revoke','review.read','review.draft','review.update','evidence.read','intake.read','escort.order.intake','escort.assignment.propose','escort.command.approve','escort.command.execute','escort.command.read','knowledge.read','security.order.intake','employee.duty.intake','recruitment.intake','accounts.intake','personal.context','calls.policy.read','calls.policy.change','workspace.read','cash.entry.create','cash.post','cash.reverse'] as const;
export const GROUP_DISCOVERY=Object.freeze([
 {id:'group-office-operations',nativeJid:'120363426895117693@g.us',accountIds:['wa-01','wa-02'],displayName:"Al-Rifa'i Integrated Services Office group",domain:'OFFICE',status:'PENDING_OWNER_VERIFICATION'},
 {id:'group-escort-program',nativeJid:'120363428977781821@g.us',accountIds:['wa-01'],displayName:'Al-Aqsa Escort Program Group',domain:'ESCORT',status:'PENDING_OWNER_VERIFICATION'},
 {id:'group-escort-release-slip',nativeJid:'120363408741101070@g.us',accountIds:['wa-01'],displayName:'Escort Release Slip',domain:'RELEASE',status:'PENDING_OWNER_VERIFICATION'},
]);
