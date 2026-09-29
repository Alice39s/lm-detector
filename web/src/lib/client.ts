import { redactPrivateMetadata } from '@fingerpoint/shared/privacy'
import { endpoint, testApi as testApiShared, type CompletionTransport } from '@fingerpoint/shared/detection'
import { assertTokenizerBank, type TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import { fuseTokenizerEvidence } from '@fingerpoint/shared/tokenizer-fusion'
import { probeTokenizer as probeTokenizerShared, tokenizerReport, type TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import { generateChallenges } from '@fingerpoint/shared/challenge-browser.js'
import { parseNumbers } from '@fingerpoint/shared/fingerprint-core.js'
import { analyzeSharedOutputs, type SharedDetector } from '@fingerpoint/shared/shared-detector'
import type { Analysis, ApiConfig, Bank, Challenge, CollectionProgress, Output } from '@fingerpoint/shared/types'
import { parseReference, referenceSamples } from '@fingerpoint/shared/reference'
import type { ReferenceBatch, ReferenceSample } from '@fingerpoint/shared/reference'
import { directHeaders, directInit } from './route'
import { readStaticData } from './static-data'
export { generateChallenges, parseNumbers }

export interface ReferenceEntry { batch: ReferenceBatch; sample: ReferenceSample }
let current:Bank|undefined, referenceCache:ReferenceBatch[]|undefined
let loading:Promise<Bank>|undefined
let detectorLoading:Promise<SharedDetector>|undefined
function loadDetector():Promise<SharedDetector>{
  return detectorLoading ??= readStaticData('shared_detector.json').then(data=>JSON.parse(data) as SharedDetector)
    .catch(error=>{detectorLoading=undefined;throw error})
}
function worker<T>(data:unknown,onProgress?:(text:string)=>void,fallback?:()=>T):Promise<T>{
  return new Promise((resolve,reject)=>{
    let w:Worker|undefined,finished=false
    const stop=()=>{finished=true;w?.terminate()}
    const unavailable=()=>{
      if(finished)return
      stop()
      if(fallback){try{resolve(fallback())}catch(error){reject(error)}}
      else reject(new Error('检测计算无法启动，请刷新页面后重试。'))
    }
    try{
      w=new Worker(new URL('./fingerprint.worker.ts',import.meta.url),{type:'module'})
      w.onmessage=({data})=>{
        if(finished)return
        if(data.progress){onProgress?.(data.progress);return}
        stop()
        if(data.error)reject(new Error(data.error));else resolve(data.result)
      }
      w.onerror=unavailable
      w.onmessageerror=unavailable
      w.postMessage(data)
    }catch{unavailable()}
  })
}
export async function loadBank():Promise<Bank>{
  if(current)return current
  if(loading)return loading
  loading=readStaticData('unified_bank.json').then(data=>JSON.parse(data) as Bank).then((bank:Bank)=>{current=bank;return bank}).catch(error=>{loading=undefined;throw error})
  return loading
}
export async function loadReferences():Promise<ReferenceBatch[]>{await loadBank();if(!referenceCache)referenceCache=parseReference(await readStaticData('unified_reference.jsonl'));return referenceCache}
export async function loadSamples(model:string):Promise<ReferenceEntry[]>{return [...referenceSamples((await loadReferences()).filter(batch=>batch.model.id===model))]}
export async function analyze(outputs:Output[],bank:Bank):Promise<Analysis>{
  const detector=await loadDetector()
  const options={allowPartial:true}
  return worker({action:'analyze',outputs,bank,detector,options},undefined,()=>analyzeSharedOutputs(outputs,bank,detector,options))
}
function sanitize(value:unknown):unknown {
  if(typeof value==='string')return redactPrivateMetadata(value.replace(/\bsk-[\w-]+/g,'[REDACTED]'))
  if(Array.isArray(value))return value.map(sanitize)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['api_key','apiKey','authorization','access_token','refresh_token'].includes(k)).map(([k,v])=>[k,sanitize(v)]))
  return value
}
function download(name:string,content:string,type='application/json'){
  const object=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=object;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(object),1000)
}
export async function exportReferences(){download('unified_reference.jsonl',(await loadReferences()).map(batch=>JSON.stringify(sanitize(batch))).join('\n')+'\n','application/x-ndjson')}
export function exportBank(bank:Bank){download('unified_bank.json',JSON.stringify(sanitize(bank),null,2)+'\n')}
/** Probe data travels with the result it was fused into, so an export always matches the ranking on screen. */
export interface ResultTokenizer { run:TokenizerRun; bank:TokenizerBank; startedAt:number; model:string }
export function exportAnalysis(result:Analysis,probe?:ResultTokenizer){
  const candidates=result.results.map(r=>({model:r.model,name:r.display_name,confidence:r.verification_confidence??r.probability??null,
    ...(r.tokenizer?{fingerprint_confidence:r.fingerprint_confidence??null,tokenizer:r.tokenizer.status,tokenizer_factor:r.tokenizer.factor}:{})}))
  // Counts, probe ids, response model names and the claimed model leave with the result; the address and key stay behind.
  const tokenizer=probe?{...tokenizerReport(probe.run,probe.bank,{createdAt:probe.startedAt,model:probe.model}),fused:result.tokenizer?.fused??false}:undefined
  download('fingerpoint-result.json',JSON.stringify(sanitize({candidates,tokenizer}),null,2)+'\n')
}
/** Combines a settled probe with the fingerprint analysis. Without an answered probe there is no evidence to add. */
export const fuseTokenizer=(analysis:Analysis,probe:ResultTokenizer)=>
  probe.run.posterior?.answered?fuseTokenizerEvidence(analysis,probe.bank,probe.run.posterior,probe.run.verdict):analysis
/** Chat Completions and Responses omit their optional output limits on both routes. */
function browserBody(config:ApiConfig,body:Record<string,unknown>){
  const requestBody={...body}
  if(config.format==='responses')delete requestBody.max_output_tokens
  else if(config.format==='openai')delete requestBody.max_tokens
  return requestBody
}
const proxyTransport:CompletionTransport = (url,config,body,signal) => {
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`,Accept:body.stream?'text/event-stream':'application/json'}
  return fetch('/api/proxy',{method:'POST',headers,body:JSON.stringify({url,format:config.format,body:browserBody(config,body)}),signal,redirect:'error',credentials:'omit'})
}
/** Calls a CORS-enabled endpoint from the browser with the header names the sniff already tested. */
const directTransport:CompletionTransport = (url,config,body,signal) =>
  fetch(url,{...directInit,method:'POST',headers:directHeaders(config.format,config.apiKey,Boolean(body.stream)),body:JSON.stringify(browserBody(config,body)),signal})
export type Route = 'direct'|'proxy'
export const transportFor = (route:Route):CompletionTransport => route==='direct'?directTransport:proxyTransport
export const testApi = (config:ApiConfig,challenges:Challenge[],onProgress:(p:CollectionProgress)=>void,route:Route,signal?:AbortSignal) =>
  testApiShared(config,challenges,onProgress,signal,transportFor(route))

let tokenizerBankLoading:Promise<TokenizerBank>|undefined
export function loadTokenizerBank():Promise<TokenizerBank>{
  return tokenizerBankLoading ??= readStaticData('tokenizer_bank.json').then(text=>{
    const bank=JSON.parse(text) as unknown
    assertTokenizerBank(bank)
    return bank
  }).catch(error=>{tokenizerBankLoading=undefined;throw error})
}
/** Four probes in flight when parallel requests are on, otherwise one at a time for the fewest requests. */
export const probeTokenizer = (config:ApiConfig,bank:TokenizerBank,route:Route,signal:AbortSignal,onUpdate:(run:TokenizerRun)=>void) =>
  probeTokenizerShared(config,bank,{url:endpoint(config),transport:transportFor(route),concurrency:config.parallel?4:1,signal,onUpdate})
