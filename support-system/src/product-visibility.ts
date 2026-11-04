import express from 'express';
import type { PoolClient } from 'pg';
import { query } from './pg';

export const VISIBILITY_STORE = 'amao04.myshoplaza.com';
export const VISIBILITY_THEME = '813b12f8-d69f-47a8-b35c-50eb1ed31ed8';
type Database = Pick<PoolClient,'query'>;
const database = {query} as Database;

/**
 * Restore only the public read contract retained by 1c038cb on 2026-11-02.
 * The unpublished pilot theme still reads its saved homepage/search rule;
 * the retired admin page, navigation and mutation routes remain removed.
 */
export function createVisibilityPublicRouter(options: {db?: Database} = {}): express.Router {
  const router=express.Router();
  const db=options.db||database;
  router.get('/amao04',async(_req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','no-store');
    try {
      const result=await db.query('SELECT enabled,keyword,tags,device,revision,updated_at FROM support_product_visibility WHERE store_subdomain=$1',[VISIBILITY_STORE]);
      if(!result.rows[0])throw new Error('Missing visibility configuration');
      res.json({ok:true,store:VISIBILITY_STORE,theme:VISIBILITY_THEME,scope:'homepage-and-search',rule:result.rows[0]});
    }catch{res.status(503).json({ok:false,error:'Configuration unavailable'});}
  });
  router.all('/amao04',(_req,res)=>{res.setHeader('Allow','GET, HEAD');res.status(405).json({ok:false,error:'This configuration is read-only.'});});
  return router;
}
