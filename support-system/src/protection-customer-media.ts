import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import multer from 'multer';
import sharp from 'sharp';
import type { Request, RequestHandler } from 'express';
import { ProtectionError } from './protection-domain';
import { EVIDENCE_LIMITS } from './protection-customer-service';

const execFileAsync=promisify(execFile);
const mimeTypes=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm']);
export function evidenceDirectory():string{return path.resolve(process.env.SUPPORT_PROTECTION_EVIDENCE_DIR||path.join(process.env.SUPPORT_PROTECTION_DATA_DIR||path.resolve(__dirname,'../protection-data'),'customer-evidence'));}
export function evidenceStoragePath(name:string):string{if(!/^[a-f0-9-]{36}\.(webp|mp4|webm)$/.test(name))throw new ProtectionError('Evidence not found.',404);return path.join(evidenceDirectory(),name);}
export async function deleteProtectionEvidence(name:string):Promise<void>{await fs.unlink(evidenceStoragePath(name)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});}
const directories=new WeakMap<Request,Promise<string>>();
const ended=new WeakSet<Request>();
async function cleanup(req:Request){
  ended.add(req);
  try{const directory=directories.get(req);if(directory)await fs.rm(await directory,{recursive:true,force:true});}
  catch{/* Directory creation may have failed; cleanup must never mask the upload error. */}
}
const uploader=multer({storage:multer.diskStorage({
  destination(req,_file,cb){
    if(ended.has(req))return cb(new Error('Upload ended'),'');
    let directory=directories.get(req);
    if(!directory){directory=fs.mkdir(path.join(evidenceDirectory(),'.tmp'),{recursive:true}).then(()=>fs.mkdtemp(path.join(evidenceDirectory(),'.tmp','upload-')));directories.set(req,directory);}
    directory.then(async dir=>{if(ended.has(req)){await cleanup(req);cb(new Error('Upload ended'),'');}else cb(null,dir);},error=>cb(error,''));
  },filename(_req,_file,cb){cb(null,crypto.randomUUID());}
}),limits:{files:1,fileSize:EVIDENCE_LIMITS.max_file_bytes,fields:2,fieldSize:100,parts:3},fileFilter(_req,file,cb){if(mimeTypes.has(file.mimetype))cb(null,true);else cb(new ProtectionError('Use JPEG, PNG, WebP, MP4, or WebM files.'));}}).single('file');
export const uploadProtectionEvidence:RequestHandler=(req,res,next)=>{
  const clean=()=>{void cleanup(req);};res.once('finish',clean);res.once('close',clean);req.once('aborted',clean);
  uploader(req,res,error=>{if(error){void cleanup(req).then(()=>next(error));}else if(req.aborted||res.destroyed)clean();else next();});
};
export async function protectionEvidenceHash(filePath:string):Promise<string>{const h=crypto.createHash('sha256');for await(const chunk of createReadStream(filePath))h.update(chunk);return h.digest('hex');}
export async function saveProtectionEvidence(file:Express.Multer.File):Promise<{storage_name:string;mime_type:string;kind:'image'|'video';size_bytes:number;original_name:string}>{
  const original_name=path.basename(file.originalname).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160)||'Evidence';
  let output:string|undefined;
  try{
    await fs.mkdir(evidenceDirectory(),{recursive:true});
    if(!file.size||file.size>EVIDENCE_LIMITS.max_file_bytes)throw new ProtectionError('Each file must be no larger than 25 MB.');
    let ext:'webp'|'mp4'|'webm',mime_type:string,kind:'image'|'video';
    if(file.mimetype.startsWith('image/')){
      const decoder=sharp(file.path,{limitInputPixels:50_000_000,failOn:'warning'}),meta=await decoder.metadata();
      if(!['jpeg','png','webp'].includes(meta.format||'')||!meta.width||!meta.height||(meta.pages||1)>1)throw new ProtectionError('This image format is not supported. Please use a still JPEG, PNG, or WebP image.');
      ext='webp';mime_type='image/webp';kind='image';
      output=evidenceStoragePath(`${crypto.randomUUID()}.${ext}`);
      await decoder.rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:90}).toFile(output);
    }else{
      const handle=await fs.open(file.path,'r');const header=Buffer.alloc(16);try{await handle.read(header,0,16,0);}finally{await handle.close();}
      const mp4=header.subarray(4,8).toString()==='ftyp',webm=header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
      if((file.mimetype==='video/mp4'&&!mp4)||(file.mimetype==='video/webm'&&!webm)||(!mp4&&!webm))throw new ProtectionError('The file is not a valid MP4 or WebM video.');
      let probe:any;
      try{const {stdout}=await execFileAsync(process.env.SUPPORT_PROTECTION_FFPROBE||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-count_packets','-show_format','-show_streams','-of','json',file.path],{timeout:15000,maxBuffer:256*1024});probe=JSON.parse(stdout);}
      catch{throw new ProtectionError('This video could not be verified. Please upload a playable MP4 or WebM file.');}
      const streams=Array.isArray(probe.streams)?probe.streams:[];
      if(!streams.some((s:any)=>s.codec_type==='video'&&Number(s.width)>0&&Number(s.height)>0&&Number(s.nb_read_packets)>0)
        ||(mp4&&!String(probe.format?.format_name).includes('mp4'))||(webm&&!String(probe.format?.format_name).includes('webm')))throw new ProtectionError('This video does not contain a valid video stream.');
      ext=mp4?'mp4':'webm';mime_type=`video/${ext}`;kind='video';output=evidenceStoragePath(`${crypto.randomUUID()}.${ext}`);await fs.copyFile(file.path,output);
    }
    const stat=await fs.stat(output);if(!stat.size||stat.size>EVIDENCE_LIMITS.max_file_bytes)throw new ProtectionError('The processed file exceeds 25 MB.');
    return{storage_name:path.basename(output),mime_type,kind,size_bytes:stat.size,original_name};
  }catch(error){if(output)await fs.unlink(output).catch(()=>{});if(error instanceof ProtectionError)throw error;throw new ProtectionError('This file could not be processed. Please choose another file.');}
  finally{await fs.unlink(file.path).catch(()=>{});}
}
export async function cleanupProtectionOrphanEvidence():Promise<number>{
  const {query}=await import('./pg');
  const rows=await query(`DELETE FROM support_protection_evidence WHERE claim_id IS NULL AND id IN (SELECT id FROM support_protection_evidence WHERE claim_id IS NULL AND created_at<now()-interval '24 hours' LIMIT 100) RETURNING storage_name`);
  for(const row of rows.rows)await deleteProtectionEvidence(row.storage_name);
  await query(`DELETE FROM support_protection_capture_sessions c WHERE c.expires_at<now()-interval '24 hours'
    AND NOT EXISTS(SELECT 1 FROM support_protection_evidence e WHERE e.capture_id=c.id)
    AND c.id IN (SELECT stale.id FROM support_protection_capture_sessions stale WHERE stale.expires_at<now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM support_protection_evidence e WHERE e.capture_id=stale.id) LIMIT 100)`);
  return rows.rows.length;
}
