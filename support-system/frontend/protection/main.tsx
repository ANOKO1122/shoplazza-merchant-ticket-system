import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProtectionStore } from '../../src/protection-types';
import { useResource } from './api';
import { Claims, type Agent } from './Claims';
import { Orders } from './Orders';
import { Overview } from './Overview';
import { ErrorNotice, Loading } from './shared';
import { EmailRecords } from './EmailRecords';
import { Stores } from './Stores';
import './styles.css';
const tabs = [{ id: 'overview', label: '概览' }, { id: 'orders', label: '保障订单' }, { id: 'claims', label: '赔付审核' }, { id: 'emails', label: '邮件记录' }, { id: 'stores', label: '店铺接入' }] as const;
type Tab = typeof tabs[number]['id'];
function fromLocation(): { tab: Tab; claim: string | null; order: string | null } {
  const params = new URLSearchParams(location.search);
  const tab = tabs.find(item => item.id === params.get('tab'))?.id || 'overview';
  return { tab, claim: params.get('claim'), order: params.get('order') };
}
function App() {
  const [navigation, setNavigation] = useState(fromLocation);
  const me = useResource<{ agent: Agent & { role: string } }>('/api/admin/me');
  const stores = useResource<{ items: ProtectionStore[] }>('/stores', 0, true);
  const agents = useResource<{ items: Agent[] }>('/agents');
  useEffect(() => {
    const listener = () => setNavigation(fromLocation());
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  useEffect(() => {
    const userName = document.getElementById('adminUserName');
    if (userName && me.data) userName.textContent = me.data.agent.name;
  }, [me.data]);
  function navigate(tab: Tab, claim: string | null = null) {
    const params = new URLSearchParams({ tab });
    if (claim) params.set('claim', claim);
    history.pushState(null, '', `${location.pathname}?${params}`);
    setNavigation({ tab, claim, order: null });
  }
  return <div className="protection-app"><header className="p-topbar"><div className="p-title"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.2 2.6 7.4 7.5 9.5 4.9-2.1 7.5-5.3 7.5-9.5V6L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="m8.5 11.7 2.3 2.3 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg><h1>运输保障</h1></div><span className="p-muted">{me.data?.agent.name || '客服后台'}</span></header>
    <nav className="p-tabs" aria-label="运输保障导航">{tabs.map(tab => <button key={tab.id} className={navigation.tab === tab.id ? 'p-tab p-tab-active' : 'p-tab'} aria-current={navigation.tab === tab.id ? 'page' : undefined} onClick={() => navigate(tab.id)}>{tab.label}</button>)}</nav>
    <main key={navigation.tab} className="p-content"><ErrorNotice error={me.error} onRetry={me.reload} /><ErrorNotice error={stores.error} onRetry={stores.reload} />{navigation.tab === 'claims' && <ErrorNotice error={agents.error} onRetry={agents.reload} />}
      {me.loading ? <Loading /> : me.data && <>
        {navigation.tab === 'overview' && <Overview stores={stores.data?.items || []} onClaims={() => navigate('claims')} />}
        {navigation.tab === 'orders' && <Orders stores={stores.data?.items || []} selectedOrder={navigation.order} onClaim={id => navigate('claims', id)} />}
        {navigation.tab === 'claims' && <Claims stores={stores.data?.items || []} agents={agents.data?.items || []} selected={navigation.claim} onSelect={id => navigate('claims', id)} />}
        {navigation.tab === 'emails' && <EmailRecords stores={stores.data?.items || []} onClaim={id => navigate('claims', id)} />}
        {navigation.tab === 'stores' && (!stores.data && stores.loading ? <Loading /> : stores.data && <Stores stores={stores.data.items} isAdmin={me.data.agent.role === 'admin'} onReload={stores.reload} />)}
      </>}
    </main></div>;
}
const main = document.getElementById('mainArea');
if (main) createRoot(main).render(<App />);
