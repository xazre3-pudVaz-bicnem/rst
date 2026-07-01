import 'dotenv/config'; import pg from 'pg'
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const c=new pg.Client({connectionString:process.env.SUPABASE_DB_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL,ssl:{rejectUnauthorized:false}}); await c.connect()
const r=await c.query("SELECT id,name,list_url FROM source_sites WHERE source_type IS DISTINCT FROM 'sequential_id_probe' AND is_active=true AND list_url IS NOT NULL ORDER BY name")
console.log(`有効サイト ${r.rows.length}件を検査中...`)
async function chk(u){ try{ const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),10000); const res=await fetch(u,{headers:{'User-Agent':UA,'Accept-Language':'ja'},redirect:'follow',signal:ctl.signal}); clearTimeout(t); return res.status }catch(e){ return 'ERR:'+(e.cause?.code||e.name||'fail') } }
const rows=r.rows, out=[]
for(let i=0;i<rows.length;i+=8){ const batch=rows.slice(i,i+8); const rs=await Promise.all(batch.map(x=>chk(x.list_url))); batch.forEach((x,j)=>out.push({...x,st:rs[j]})) }
const bad=out.filter(x=>x.st!==200)
console.log(`\n=== NG ${bad.length}件 / OK ${out.length-bad.length}件 ===`)
for(const x of bad) console.log(`  ${x.st}\t${x.name}\t${x.list_url}`)
import('fs').then(fs=>fs.writeFileSync('scripts/_health.json',JSON.stringify(bad,null,2)))
await c.end()
