import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('screenshots', {recursive:true});
process.env.VISION_ENGINEERING_URL='http://127.0.0.1:8115';
const backend=spawn('.python313/python.exe',['server/engineering_server.py'],{env:{...process.env,VISION_ENGINEERING_PORT:'8115'},windowsHide:true});
let logs='';backend.stderr.on('data',chunk=>logs+=chunk);
let server,browser;
try {
  let health;
  for(let attempt=0;attempt<50;attempt++) {
    try { health=await (await fetch('http://127.0.0.1:8115/health')).json(); break; }
    catch { await new Promise(resolve=>setTimeout(resolve,200)); }
  }
  assert.equal(health?.usd_brep,'1.0.0');
  console.log('HEALTH',JSON.stringify(health));
  server=await createServer({server:{host:'127.0.0.1',port:4175,strictPort:true}});await server.listen();
  const response=await fetch('http://127.0.0.1:8115/cad/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({script:"length=parameters.setdefault('length',100);result={'beam':u.create_box((-50,-10,-5),length,20,10)}"})});
  const cad=await response.json();assert.equal(response.status,200,JSON.stringify(cad));
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:4175');await page.getByRole('textbox',{name:'工程需求'}).waitFor();
  await page.evaluate(async cad=>{
    const {useAppStore}=await import('/src/state/store.ts');
    const {cadArtifactFromResult}=await import('/src/services/engineeringBackend.ts');
    useAppStore.getState().adoptExternalModel({name:'原生面多载荷回归',script:"length=parameters.setdefault('length',100);result={'beam':u.create_box((-50,-10,-5),length,20,10)}",stlBase64:cad.stlBase64,metrics:cad.metrics,cad:cadArtifactFromResult(cad)});
    useAppStore.getState().configureStudy({mesh:{...useAppStore.getState().model.mesh,cellSizeMm:4}});
  },cad);
  await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByText('实体与拓扑',{exact:true}).click();await page.getByText('beam · 实体',{exact:true}).click();
  await page.getByText('查询内核接口',{exact:true}).click();await page.getByLabel('函数或分类').fill('pipe_sweep');await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.locator('.native-cad-panel').getByText('usd_brep.pipe_sweep',{exact:true}).first().waitFor();
  await page.getByText('查询内核接口',{exact:true}).click();
  await page.getByText('分析实体与工况',{exact:true}).click();
  const support=page.locator('.study-editor details').nth(0);
  await support.locator('summary').click();await support.getByLabel('作用区域').selectOption('cad-face');
  const faces=cad.bodies[0].faces;
  const left=faces.reduce((a,b)=>a.bbox_mm.max[0]<b.bbox_mm.max[0]?a:b).id;
  const right=faces.reduce((a,b)=>a.bbox_mm.min[0]>b.bbox_mm.min[0]?a:b).id;
  await support.getByLabel('选择原生面（可多选）').selectOption([left]);
  const load=page.locator('.study-editor details').nth(1);
  await load.locator('summary').click();await load.getByLabel('作用区域').selectOption('cad-face');
  await load.getByLabel('选择原生面（可多选）').selectOption([right]);await load.getByLabel('合力 N').fill('100');
  await load.getByLabel('载荷方向 X',{exact:true}).fill('1');await load.getByLabel('载荷方向 Z',{exact:true}).fill('0');
  await page.getByRole('button',{name:'添加载荷',exact:true}).click();
  const second=page.locator('.study-editor details').nth(2);
  await second.locator('summary').click();await second.getByLabel('合力 N').fill('100');
  await second.getByLabel('载荷方向 X',{exact:true}).fill('1');await second.getByLabel('载荷方向 Z',{exact:true}).fill('0');
  await second.getByLabel('作用区域').selectOption('cad-face');await second.getByLabel('选择原生面（可多选）').selectOption([right]);
  await page.screenshot({path:'screenshots/native-study.png'});
  await page.getByRole('button',{name:'保存工况',exact:true}).click();
  assert.equal(await page.evaluate(async()=>(await import('/src/state/store.ts')).useAppStore.getState().model.loads.length),2);
  await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByRole('button',{name:'运行分析',exact:true}).click();
  await page.getByText('线性静力 · 结果评估',{exact:true}).waitFor({timeout:120000});
  await page.getByRole('button',{name:'重新求解',exact:true}).waitFor({timeout:120000});
  const result=await page.evaluate(async()=>{
    const state=(await import('/src/state/store.ts')).useAppStore.getState();
    return {solver:state.analysis?.solver,boundaries:state.analysis?.boundaryEvidence,displacement:state.analysis?.maxDisplacement,stale:state.resultStale,error:state.analysisError,status:state.analysisStatus,toasts:state.toasts};
  });console.log('RESULT',JSON.stringify(result));console.log('PAGE_ERRORS',JSON.stringify(errors));assert.equal(result.solver.method,'scikit-fem');assert.equal(result.boundaries.length,3);assert.ok(result.solver.converged);
  await page.screenshot({path:'screenshots/native-analysis.png'});
  let release;
  const paused=new Promise(resolve=>{release=resolve;});
  let arrived;
  const requested=new Promise(resolve=>{arrived=resolve;});
  await page.route('**/api/engineering/fea/solve',async route=>{arrived();await paused;await route.continue();});
  await page.getByRole('button',{name:'重新求解',exact:true}).click();
  await requested;
  await page.getByText('本轮计算中 · 当前显示上一轮结果',{exact:true}).first().waitFor();
  assert.equal(await page.locator('.analysis-busy > .mono').count(),0,'unknown progress must not show a percentage');
  assert.ok(await page.getByRole('button',{name:'导出报告',exact:true}).isDisabled());
  assert.equal(await page.locator('.analysis-right .limit-row').getByText('PASS',{exact:true}).count(),0,'prior result must not pass the active run');
  await page.screenshot({path:'screenshots/native-recalculating.png'});
  release();
  await page.locator('.analysis-busy').waitFor({state:'hidden',timeout:120000});
  await page.getByText('本轮分析已完成',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'导出报告',exact:true}).isDisabled(),false);
  await page.unroute('**/api/engineering/fea/solve');
  console.log('PASS recalculation labels prior results, has no fake percentage, clears busy on completion');
  await page.getByRole('button',{name:'返回设计',exact:true}).click();
  await page.getByText('视图设置',{exact:true}).click();await page.getByLabel('显示载荷与约束',{exact:true}).check();
  await page.locator('.scene-label--load').nth(1).waitFor();assert.equal(await page.locator('.scene-label--load').count(),2);assert.equal(await page.locator('.scene-label--fixed').count(),1);
  await page.getByText('视图设置',{exact:true}).click();
  const inspect=()=>({small:[...document.querySelectorAll('body *')].filter(e=>e.children.length===0&&e.textContent.trim()&&e.getBoundingClientRect().width&&parseFloat(getComputedStyle(e).fontSize)<14).map(e=>[e.className,getComputedStyle(e).fontSize]),overflow:document.documentElement.scrollWidth>innerWidth});
  for(const width of [1440,1024,600]) {
    await page.setViewportSize({width,height:900});const check=await page.evaluate(inspect);console.log('UI',width,JSON.stringify(check));assert.equal(check.overflow,false);assert.equal(check.small.length,0);
  }
  assert.deepEqual(errors,[]);console.log('PASS real native CAD -> face/multi-load UI -> FEA -> annotations');
} catch(error) { console.error(logs.slice(-4000));throw error; }
finally {if(browser)await browser.close();if(server)await server.close();backend.kill();}

