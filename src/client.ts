type TrueForgeClient = InstanceType<typeof import('@truefoundry/trueforge-sdk', { with: { 'resolution-mode': 'import' } }).TrueForge>;
export const instructions = 'You are FakeFoundy, a workspace coding assistant. Use the editor MCP tools to read files before proposing changes. propose_edit only stages changes; never claim that pending edits were applied. Do not call model providers directly.';
export async function createClient(baseUrl: string) {
  const url=new URL(baseUrl);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.protocol!=='http:') throw new Error('This prototype supports local HTTP TrueForge only');
  const {TrueForge}=await import('@truefoundry/trueforge-sdk');
  return new TrueForge({baseUrl,maxRetries:0});
}
export async function runTurn(client: TrueForgeClient, model: string, prompt: string, onEvent:(event:unknown)=>void) {
  const session=await client.sessions.create({agent:{spec:{instructions,model:{name:model},mcpServers:[{name:'fakefoundy-editor',preload:true,requireApprovalForTools:[]}]}}});
  const stream=await client.sessions.createTurnStream(session.data.id,{input:[{type:'user.message',content:prompt}]});
  for await (const event of stream) onEvent(event);
  return session.data.id;
}
