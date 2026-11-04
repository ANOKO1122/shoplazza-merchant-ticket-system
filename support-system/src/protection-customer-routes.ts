import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import multer from 'multer';
import { getRequestAgent } from './auth';
import { query } from './pg';
import { ProtectionError, isSameOriginMutation } from './protection-domain';
import { transaction } from './protection-service';
import { PROTECTION_COOKIE, createProtectionAccessLink, exchangeProtectionAccessToken, getProtectionCustomer, type ProtectionCustomerIdentity } from './protection-customer-auth';
import { EVIDENCE_LIMITS, addCustomerClaimMessage, createCustomerClaim, createCustomerCaptureSession, evidenceView, getCustomerClaim, getCustomerOrder } from './protection-customer-service';
import { deleteProtectionEvidence, evidenceStoragePath, protectionEvidenceHash, saveProtectionEvidence, uploadProtectionEvidence } from './protection-customer-media';

type CustomerRequest=express.Request&{protectionCustomer:ProtectionCustomerIdentity};
const handler=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>):express.RequestHandler=>(req,res,next)=>{Promise.resolve(fn(req,res)).catch(next);};
const errors:express.ErrorRequestHandler=(error,_req,res,_next)=>{
  if(res.headersSent)return;
  if(error instanceof ProtectionError){res.status(error.status).json({ok:false,error:error.message});return;}
  if(error instanceof multer.MulterError){res.status(400).json({ok:false,error:'Upload one file at a time, up to 25 MB.'});return;}
  console.error('[protection-customer] Request failed');res.status(500).json({ok:false,error:'The request could not be completed. Please try again.'});
};
const requireCustomer:express.RequestHandler=(req,res,next)=>{getProtectionCustomer(req).then(identity=>{
  if(!identity){res.status(401).json({ok:false,error:'Please open your secure access link again.'});return;}
  const reference=req.get('X-Protection-Reference'),write=!['GET','HEAD','OPTIONS'].includes(req.method);
  if((write&&!reference)||(reference&&reference!==identity.publicNo)){
    res.status(409).json({ok:false,error_code:'protection_reference_mismatch',error:'Another order was opened in this browser. Please reopen the secure email link for the order shown on this page.'});return;
  }
  (req as CustomerRequest).protectionCustomer=identity;next();
}).catch(next);};
const mutations:express.RequestHandler=(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!isSameOriginMutation(req.get('Origin'),req.get('Sec-Fetch-Site'),req.protocol,req.get('Host'))){res.status(403).json({ok:false,error:'Cross-site requests are not allowed.'});return;}
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.path!=='/evidence'&&!req.is('application/json')){res.status(415).json({ok:false,error:'Use JSON for this request.'});return;}
  next();
};
export function createProtectionCustomerRouter():express.Router{
  const router=express.Router();router.use(mutations);
  router.post('/session',rateLimit({windowMs:60*1000,max:15,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Too many access attempts. Please try again shortly.'}}),handler(async(req,res)=>{
    const session=await exchangeProtectionAccessToken(req.body?.access_token);
    res.cookie(PROTECTION_COOKIE,session.session,{httpOnly:true,secure:req.secure,sameSite:'lax',path:'/api/protection',maxAge:12*60*60*1000});res.json({ok:true,protection_no:session.protection_no});
  }));
  router.get('/evidence/:id',handler(async(req,res)=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))throw new ProtectionError('Evidence not found.',404);
    const [customer,agent]=await Promise.all([getProtectionCustomer(req),getRequestAgent(req)]);
    if(!customer&&!agent)throw new ProtectionError('Please open your secure access link again.',401);
    const r=await query('SELECT * FROM support_protection_evidence WHERE id=$1',[req.params.id]);const file=r.rows[0];
    if(!file||(!agent&&(String(file.protection_order_id)!==customer!.orderId||(!file.claim_id&&file.session_hash!==customer!.sessionHash))))throw new ProtectionError('Evidence not found.',404);
    res.setHeader('Content-Type',file.mime_type);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
    res.setHeader('Content-Disposition',`inline; filename="evidence.${file.kind==='image'?'webp':file.mime_type==='video/mp4'?'mp4':'webm'}"`);
    res.sendFile(evidenceStoragePath(file.storage_name),{cacheControl:false,acceptRanges:true},error=>{if(error&&!res.headersSent)res.status(404).end();});
  }));
  router.use(requireCustomer);
  router.delete('/evidence/:id',handler(async(req,res)=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))throw new ProtectionError('Evidence not found.',404);
    const identity=(req as CustomerRequest).protectionCustomer;
    const result=await query('DELETE FROM support_protection_evidence WHERE id=$1 AND protection_order_id=$2 AND session_hash=$3 AND claim_id IS NULL RETURNING storage_name',[req.params.id,identity.orderId,identity.sessionHash]);
    if(!result.rows[0])throw new ProtectionError('Only your unsubmitted evidence files can be removed.',404);
    await deleteProtectionEvidence(result.rows[0].storage_name);res.json({ok:true});
  }));
  router.get('/order',handler(async(req,res)=>res.json(await getCustomerOrder((req as CustomerRequest).protectionCustomer))));
  router.post('/capture-sessions',rateLimit({windowMs:60*1000,max:30,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Please wait before opening the camera again.'}}),handler(async(req,res)=>res.status(201).json({ok:true,capture:await createCustomerCaptureSession((req as CustomerRequest).protectionCustomer,req.body)})));
  router.post('/evidence',rateLimit({windowMs:60*1000,max:12,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Please wait before uploading more evidence.'}}),uploadProtectionEvidence,handler(async(req,res)=>{
    if(!req.file)throw new ProtectionError('Please choose a file.');
    const uploadId=req.body?.upload_id;
    if(typeof uploadId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId))throw new ProtectionError('Please select the file again and retry.');
    if(Object.keys(req.body||{}).some(key=>!['upload_id','capture_id'].includes(key)))throw new ProtectionError('Unsupported evidence fields.');
    const captureId=req.body?.capture_id??null;
    if(captureId!==null&&(typeof captureId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(captureId)))throw new ProtectionError('Please open the camera again before taking this photo.');
    if(captureId&&!req.file.mimetype.startsWith('image/'))throw new ProtectionError('The camera flow accepts still photos only.');
    const uploadHash=await protectionEvidenceHash(req.file.path);
    const identity=(req as CustomerRequest).protectionCustomer,file=await saveProtectionEvidence(req.file),id=crypto.randomUUID();
    let persisted:any;
    try{
      if(req.aborted||res.destroyed)throw new ProtectionError('The upload was cancelled.');
      persisted=await transaction(async client=>{
        await client.query('SELECT id FROM support_protection_orders WHERE id=$1 FOR UPDATE',[identity.orderId]);
        const duplicate=await client.query('SELECT * FROM support_protection_evidence WHERE protection_order_id=$1 AND session_hash=$2 AND upload_id=$3',[identity.orderId,identity.sessionHash,uploadId]);
        // A lost response can be retried after the five-minute capture window;
        // it must describe the same immutable file and capture, not consume again.
        if(duplicate.rows[0]){if(duplicate.rows[0].upload_hash!==uploadHash||(duplicate.rows[0].capture_id||null)!==(captureId?captureId.toLowerCase():null))throw new ProtectionError('This upload was already used for a different file or capture.',409);return duplicate.rows[0];}
        let capture:any=null;
        if(captureId){
          const r=await client.query('SELECT *,expires_at>clock_timestamp() AS active FROM support_protection_capture_sessions WHERE id=$1 FOR UPDATE',[captureId]);capture=r.rows[0];
          if(!capture||String(capture.protection_order_id)!==identity.orderId||capture.session_hash!==identity.sessionHash)throw new ProtectionError('This camera session is unavailable. Please open the camera again.');
          if(capture.upload_id)throw new ProtectionError('This camera session has already been used. Please take a new photo.',409);
          if(!capture.active)throw new ProtectionError('This camera session has expired. Please open the camera and take a new photo.');
          if(file.kind!=='image')throw new ProtectionError('The camera flow accepts still photos only.');
        }
        const totals=await client.query(`SELECT count(*) FILTER(WHERE claim_id IS NULL AND session_hash=$2)::int AS pending,
          COALESCE(sum(size_bytes) FILTER(WHERE claim_id IS NULL AND session_hash=$2),0) AS pending_bytes,COALESCE(sum(size_bytes),0) AS total_bytes FROM support_protection_evidence WHERE protection_order_id=$1`,[identity.orderId,identity.sessionHash]);
        // A cancelled tab may leave an upload whose response was never received.
        // Submission limits stay at six files / 100 MB; bounded draft headroom
        // lets the customer retry while the 24-hour orphan cleaner runs.
        const t=totals.rows[0];if(t.pending>=24||Number(t.pending_bytes)+file.size_bytes>200*1024*1024||Number(t.total_bytes)+file.size_bytes>500*1024*1024)throw new ProtectionError('The evidence upload limit has been reached. You can continue with files already attached to this request.');
        let receivedAt:Date|null=null;
        if(capture){
          const consumed=await client.query(`UPDATE support_protection_capture_sessions SET upload_id=$2,upload_hash=$3,received_at=clock_timestamp() WHERE id=$1 AND upload_id IS NULL AND expires_at>clock_timestamp() RETURNING received_at`,[capture.id,uploadId,uploadHash]);
          if(!consumed.rows[0])throw new ProtectionError('This camera session has expired. Please take a new photo.');receivedAt=consumed.rows[0].received_at;
        }
        const inserted=await client.query(`INSERT INTO support_protection_evidence(id,protection_order_id,session_hash,storage_name,mime_type,kind,original_name,size_bytes,upload_id,upload_hash,source,capture_id,capture_category,capture_requested_at,capture_received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[id,identity.orderId,identity.sessionHash,file.storage_name,file.mime_type,file.kind,file.original_name,file.size_bytes,uploadId,uploadHash,capture?'camera':'upload',capture?.id||null,capture?.category||null,capture?.requested_at||null,receivedAt]);
        return inserted.rows[0];
      });
    }catch(error){await deleteProtectionEvidence(file.storage_name);throw error;}
    if(persisted.id!==id)await deleteProtectionEvidence(file.storage_name);
    res.status(201).json({ok:true,evidence:evidenceView(persisted)});
  }));
  router.post('/claims',rateLimit({windowMs:60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Please wait before submitting another request.'}}),handler(async(req,res)=>res.status(201).json({ok:true,claim:await createCustomerClaim((req as CustomerRequest).protectionCustomer,req.body)})));
  router.get('/claims/:publicNo',handler(async(req,res)=>{const claim=await getCustomerClaim((req as CustomerRequest).protectionCustomer.orderId,req.params.publicNo);if(!claim)throw new ProtectionError('Request not found.',404);res.json({ok:true,claim});}));
  router.post('/claims/:publicNo/messages',rateLimit({windowMs:60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Please wait before adding more information.'}}),handler(async(req,res)=>res.status(201).json({ok:true,claim:await addCustomerClaimMessage((req as CustomerRequest).protectionCustomer,req.params.publicNo,req.body)})));
  router.use(errors);return router;
}
export function createProtectionCustomerAdminRouter():express.Router{
  const router=express.Router();
  router.post('/orders/:id/access-link',mutations,handler(async(req,res)=>{
    const agent=await getRequestAgent(req);if(!agent)throw new ProtectionError('未登录',401);
    res.json({ok:true,url:await createProtectionAccessLink(req.params.id)});
  }));router.use(errors);return router;
}
