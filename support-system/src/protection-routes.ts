import express from 'express';
import { getRequestAgent } from './auth';
import { query } from './pg';
import { ProtectionError, csvCell, isSameOriginMutation } from './protection-domain';
import { createProtectionClaim, updateProtectionClaim, listProtectionOrders, listProtectionClaims, getProtectionOrder, getProtectionClaim, getProtectionStats, type ProtectionFilters } from './protection-service';
import { getCustomerClaimForAdmin } from './protection-customer-service';
import { processProtectionNotifications, requestProtectionClaimUpdate } from './protection-notification';

function filters(req:express.Request):ProtectionFilters {
  const result:ProtectionFilters={};
  for(const key of ['q','store','from','to','status','reason'] as const){
    const value=req.query[key];
    if(value!==undefined){if(typeof value!=='string')throw new ProtectionError('查询参数无效');if(value.trim())result[key]=value.trim();}
  }
  for(const key of ['page','page_size'] as const){const value=req.query[key];if(value!==undefined){if(typeof value!=='string'||!/^\d+$/.test(value))throw new ProtectionError('分页参数无效');result[key]=Number(value);}}
  return result;
}
function handler(fn:(req:express.Request,res:express.Response)=>Promise<unknown>):express.RequestHandler {
  return (req,res)=>{Promise.resolve(fn(req,res)).catch(error=>{
    if(res.headersSent)return;
    if(error instanceof ProtectionError){res.status(error.status).json({ok:false,error:error.message});return;}
    console.error('[protection] API request failed');
    res.status(500).json({ok:false,error:'操作未完成，请稍后重试'});
  });};
}
const decimal=(value:number|null)=>value===null?'':(value/100).toFixed(2);

export function createProtectionRouter():express.Router {
  const router=express.Router();
  // This router owns authentication even when mounted independently.
  router.use(async(req,res,next)=>{
    try{
      const agent=await getRequestAgent(req);
      if(!agent){res.status(401).json({ok:false,error:'未登录'});return;}
      (req as any).protectionAgent=agent;
      res.setHeader('Cache-Control','no-store');
      if(!['GET','HEAD','OPTIONS'].includes(req.method)){
        if(!isSameOriginMutation(req.get('Origin'),req.get('Sec-Fetch-Site'),req.protocol,req.get('Host'))){res.status(403).json({ok:false,error:'拒绝跨站或来源不明的修改请求'});return;}
        if(!req.is('application/json')){res.status(415).json({ok:false,error:'请使用JSON格式提交'});return;}
      }
      next();
    }catch{res.status(500).json({ok:false,error:'暂时无法验证登录状态'});}
  });
  router.get('/stats',handler(async(req,res)=>res.json({ok:true,...await getProtectionStats(filters(req))})));
  router.get('/agents',handler(async(_req,res)=>{
    const rows=await query('SELECT id,name FROM support_agents WHERE enabled=true ORDER BY name,id');
    res.json({ok:true,items:rows.rows.map(row=>({id:Number(row.id),name:row.name}))});
  }));

  router.get('/orders/export',handler(async(req,res)=>{
    const selected=filters(req),rows:unknown[][]=[['保障编号','店铺','订单号','客户','邮箱','币种','订单金额','保障费','保障商品金额','支付状态','履约状态','支付时间']];
    for(let page=1;page<=100;page++){
      const result=await listProtectionOrders({...selected,page,page_size:100});
      if(result.total>10000)throw new ProtectionError('导出最多10000条，请缩小筛选范围');
      rows.push(...result.items.map(order=>[order.public_no,order.store_subdomain,order.order_number,order.customer_name,order.customer_email,order.currency,decimal(order.order_amount_cents),decimal(order.protection_fee_cents),decimal(order.protected_value_cents),order.payment_status,order.fulfillment_status,order.paid_at]));
      if(page*100>=result.total)break;
    }
    res.setHeader('Content-Disposition','attachment; filename="protected-orders.csv"');
    res.type('text/csv').send('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));
  }));
  router.get('/claims/export',handler(async(req,res)=>{
    const selected=filters(req),rows:unknown[][]=[['申请编号','保障编号','店铺','订单号','客户','邮箱','类型','状态','币种','申请金额','批准金额','负责人','申请时间','外部处理记录']];
    for(let page=1;page<=100;page++){
      const result=await listProtectionClaims({...selected,page,page_size:100});
      if(result.total>10000)throw new ProtectionError('导出最多10000条，请缩小筛选范围');
      rows.push(...result.items.map(claim=>[claim.public_no,claim.protection_public_no,claim.store_subdomain,claim.order_number,claim.customer_name,claim.customer_email,claim.reason,claim.status,claim.currency,decimal(claim.requested_amount_cents),decimal(claim.approved_amount_cents),claim.assignee_name,claim.created_at,claim.external_reference]));
      if(page*100>=result.total)break;
    }
    res.setHeader('Content-Disposition','attachment; filename="protection-claims.csv"');
    res.type('text/csv').send('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));
  }));
  router.get('/orders',handler(async(req,res)=>res.json(await listProtectionOrders(filters(req)))));
  router.get('/orders/:id',handler(async(req,res)=>{
    const detail=await getProtectionOrder(req.params.id);
    if(!detail){res.status(404).json({ok:false,error:'保障订单不存在'});return;}
    res.json({ok:true,...detail});
  }));
  router.get('/claims',handler(async(req,res)=>res.json(await listProtectionClaims(filters(req)))));
  router.get('/claims/:id',handler(async(req,res)=>{
    const detail=await getProtectionClaim(req.params.id);
    if(!detail){res.status(404).json({ok:false,error:'申请不存在'});return;}
    res.json({ok:true,...detail,customer_submission:await getCustomerClaimForAdmin(req.params.id)});
  }));
  router.post('/claims',handler(async(req,res)=>res.status(201).json({ok:true,claim:await createProtectionClaim(req.body,(req as any).protectionAgent)})));
  router.patch('/claims/:id',handler(async(req,res)=>res.json({ok:true,claim:await updateProtectionClaim(req.params.id,req.body,(req as any).protectionAgent)})));
  router.post('/claims/:id/notify-email',handler(async(req,res)=>{
    const job=await requestProtectionClaimUpdate(req.params.id,req.body?.revision);
    if(job.status==='pending') await processProtectionNotifications({limit:1,onlyJobId:job.id});
    const latest=(await query('SELECT status FROM support_protection_notification_outbox WHERE id=$1',[job.id])).rows[0];
    res.json({ok:true,job_id:job.id,status:latest?.status||job.status});
  }));
  return router;
}
