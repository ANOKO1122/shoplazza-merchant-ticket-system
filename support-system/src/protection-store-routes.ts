import express from 'express';
import { getRequestAgent } from './auth';
import { isSameOriginMutation } from './protection-domain';
import { enqueueProtectionInstall, getProtectionInstallJob, listProtectionStores, ProtectionStoreError } from './protection-store-service';

export function createProtectionStoreRouter(): express.Router {
  const router = express.Router();
  router.use(['/stores','/jobs'],async (req,res,next) => {
    try {
      const agent = await getRequestAgent(req);
      if (!agent) { res.status(401).json({ok:false,error:'请先登录'}); return; }
      res.setHeader('Cache-Control','no-store');
      (req as any).protectionAgent = agent;
      if (!['GET','HEAD'].includes(req.method)) {
        if (!isSameOriginMutation(req.get('Origin'),req.get('Sec-Fetch-Site'),req.protocol,req.get('host'))) { res.status(403).json({ok:false,error:'请从本站后台提交操作'}); return; }
        if (!req.is('application/json')) { res.status(415).json({ok:false,error:'请使用JSON格式提交'}); return; }
        if (agent.role !== 'admin') { res.status(403).json({ok:false,error:'仅管理员可管理组件安装'}); return; }
      }
      next();
    } catch { res.status(500).json({ok:false,error:'无法验证登录，请稍后重试'}); }
  });
  router.get('/stores',async (_req,res) => { try { res.json({ok:true,items:await listProtectionStores()}); } catch {res.status(500).json({ok:false,error:'读取店铺失败'});} });
  router.post('/stores/:id/actions',async (req,res) => {
    try { res.status(202).json({ok:true,job:await enqueueProtectionInstall(Number(req.params.id),req.body?.action,(req as any).protectionAgent)}); }
    catch (e) { res.status(e instanceof ProtectionStoreError ? e.status : 500).json({ok:false,error:e instanceof ProtectionStoreError ? e.message : '未能创建操作，请稍后重试'}); }
  });
  router.get('/jobs/:id',async (req,res) => { try { const job=await getProtectionInstallJob(req.params.id); res.status(job?200:404).json(job?{ok:true,job}:{ok:false,error:'操作记录不存在'}); } catch {res.status(500).json({ok:false,error:'读取操作记录失败'});} });
  return router;
}
