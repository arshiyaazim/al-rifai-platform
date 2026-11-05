export type CashRow={id:string;date:string;time:string;employeePhone:string;payoutPhone:string;name:string;amountCents:number;method:string;source:string;sourceId:string;sourceLine:number;sourceText:string;sender:string;category:string;status:string;purpose:string;issues:string[];identityVerified?:boolean;identityRule?:string;senderPhone?:string;receiverIdentity?:string};
export type ReviewRow={id:string;date:string;time:string;body:string;sender:string;line:number;reason:string;status?:string;note?:string};
export type PaymentDraft={id:string;name:string;employeePhone:string;payoutPhone:string;method:string;amountCents:number;purpose:string;date:string;instruction:string;createdAt?:string};
export const money=(cents:number)=>new Intl.NumberFormat('en-BD',{style:'currency',currency:'BDT',maximumFractionDigits:2}).format(cents/100);
export function validPhone(s:string){return /^01[3-9]\d{8}$/.test(s);}
export function validateDraft(v:Record<string,unknown>):Omit<PaymentDraft,'id'>{
 const name=String(v.name??'').trim(),employeePhone=String(v.employeePhone??'').trim(),payoutPhone=String(v.payoutPhone??'').trim(),method=String(v.method??''),purpose=String(v.purpose??'').trim(),date=String(v.date??'');
 if(!name||name.length>100)throw new Error('Enter an employee name (up to 100 characters).');
 if(!validPhone(employeePhone)||!validPhone(payoutPhone))throw new Error('Use an 11-digit Bangladesh employee and payout number.');
 if(!['bkash','nagad','cash','rocket','bank'].includes(method))throw new Error('Choose a payment method.');
 const amount=String(v.amount??'');if(!/^\d{1,8}(\.\d{1,2})?$/.test(amount))throw new Error('Enter a positive amount with at most two decimal places.');
 const amountCents=Math.round(Number(amount)*100);if(amountCents<=0||amountCents>100000000)throw new Error('Amount must be between ৳0.01 and ৳1,000,000.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Enter a valid date.');
 if(!purpose||purpose.length>500)throw new Error('Enter a purpose (up to 500 characters).');
 const code=({bkash:'B',nagad:'N',cash:'C',rocket:'R',bank:'BANK'} as Record<string,string>)[method];
 return {name,employeePhone,payoutPhone,method,purpose,date,amountCents,instruction:`ID: ${employeePhone} ${name} ${payoutPhone}(${code}) ${(amountCents/100).toFixed(amountCents%100?2:0)}/-`};
}
export function calculateSettlement(v:Record<string,unknown>){
 const name=String(v.name??'').trim(),employeePhone=String(v.employeePhone??''),reference=String(v.reference??'').trim();
 if(!name||name.length>100||!validPhone(employeePhone))throw new Error('Enter a name and valid employee ID phone.');
 if(!reference||reference.length>500||v.verified!==true)throw new Error('Verify the duty period and supply its source reference.');
 const number=(key:string,max:number)=>{const n=Number(v[key]);if(!Number.isFinite(n)||n<0||n>max)throw new Error('Invalid '+key);return n;};
 const days=number('days',366),rate=number('rate',100000),foodDays=number('foodDays',366),advance=number('advance',1000000),otherDeductions=number('otherDeductions',1000000),allowance=number('allowance',1000000);
 if(!days||!rate||!Number.isInteger(days*2)||!Number.isInteger(foodDays*2)||foodDays>days)throw new Error('Use verified duty/food days in half-day increments, with food days no greater than duty days.');
 const earnedCents=Math.round(days*rate*100),foodCents=Math.round(foodDays*15000),advanceCents=Math.round(advance*100),deductionCents=Math.round(otherDeductions*100),allowanceCents=Math.round(allowance*100);
 return {name,employeePhone,reference,days,rate,foodDays,earnedCents,foodCents,advanceCents,deductionCents,allowanceCents,netCents:earnedCents+allowanceCents-foodCents-advanceCents-deductionCents,status:'Settlement draft'};
}
