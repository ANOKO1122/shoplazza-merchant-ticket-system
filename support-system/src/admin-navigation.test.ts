import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ADMIN_PAGE_FILES } from './admin-pages';

const publicDir = path.resolve(__dirname, '../public');
const source = fs.readFileSync(path.join(publicDir, 'admin-shell.js'), 'utf8');
const declared = source.match(/var ADMIN_LINKS = (\[[\s\S]*?\n  \]);/);
assert.ok(declared, 'the shell must declare its shared navigation');
const masterLinks: string[][] = vm.runInNewContext(declared[1]);
const masterPaths = Array.from(masterLinks, item => item[0]);

test('shared mailbox has an authenticated admin route and a sidebar entry', () => {
  assert.equal(ADMIN_PAGE_FILES.get('/thinkpro-admin/mailbox'), 'admin-mailbox.html');
  assert.ok(masterPaths.includes('/thinkpro-admin/mailbox'));
});

test('React mailbox page opens with a full navigation so its bundle mounts', () => {
  const view = fixture([], '/thinkpro-admin');
  view.context.adminGo('/thinkpro-admin/mailbox');
  assert.equal(view.context.location.href, '/thinkpro-admin/mailbox');
});

// The browser fixture below only models sidebar DOM operations; all navigation
// reconciliation and active-state behavior execute the real admin-shell.js.
class Node {
  id = '';
  className = '';
  innerHTML = '';
  textContent = '';
  children: Node[] = [];
  parent: Node | null = null;
  attributes: Record<string, string> = {};
  constructor(public tag = 'div') {}
  get href() { return this.attributes.href; }
  set href(value: string) { this.attributes.href = value; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  appendChild(child: Node) { return this.insertBefore(child, null); }
  insertBefore(child: Node, next: Node | null) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const at = next ? this.children.indexOf(next) : this.children.length;
    assert.ok(at >= 0, 'insertBefore target belongs to its parent');
    this.children.splice(at, 0, child); child.parent = this; return child;
  }
  insertAdjacentElement(position: string, child: Node) {
    assert.equal(position, 'afterend');
    assert.ok(this.parent);
    this.parent.insertBefore(child, this.parent.children[this.parent.children.indexOf(this) + 1] || null);
  }
  get classList() {
    return { toggle: (name: string, enabled: boolean) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) values.add(name); else values.delete(name);
      this.className = Array.from(values).join(' ');
    } };
  }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap(child => {
      const href = selector.match(/\[href="([^"]+)"\]/)?.[1];
      const tag = selector.match(/^[a-z]+/)?.[0];
      const cls = selector.match(/\.([\w-]+)/)?.[1];
      const match = (!href || child.href === href) && (!tag || child.tag === tag) && (!cls || child.className.split(/\s+/).includes(cls));
      return [...(match ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}

function link(href: string, target?: string) {
  const node = new Node('a'); node.className = 'nav-item'; node.href = href;
  if (target) node.setAttribute('target', target);
  return node;
}

function fixture(links: Node[], current = '/thinkpro-admin/email-templates', fresh = false) {
  const menu = new Node('nav'); menu.className = 'nav-menu'; links.forEach(item => menu.appendChild(item));
  const aside = new Node('aside'); aside.className = 'sidebar'; aside.appendChild(menu);
  const main = new Node(); main.className = 'main';
  const app = new Node(); app.id = 'app';
  const ready: Array<() => void> = [];
  const document = {
    readyState: 'loading',
    body: new Node('body'),
    createElement: (tag: string) => new Node(tag),
    getElementById: (id: string) => id === aside.id ? aside : id === main.id ? main : id === app.id ? app : null,
    querySelector: (selector: string) => fresh ? null : selector.includes('sidebar') ? aside : selector === '.app > .main' ? main : null,
    querySelectorAll: () => [],
    addEventListener: (event: string, callback: () => void) => { if (event === 'DOMContentLoaded') ready.push(callback); },
  };
  const context = vm.createContext({ document, location: { pathname: current, origin: 'https://support.example.test' }, URL, setInterval, clearInterval, console, addEventListener() {} });
  context.window = context;
  vm.runInContext(source, context, { filename: 'admin-shell.js' });
  ready.forEach(callback => callback());
  return { menu, aside, main, app, context };
}

function paths(menu: Node) { return menu.querySelectorAll('a.nav-item').map(item => new URL(item.href, 'https://support.example.test').pathname); }

test('adopting the real template sidebar restores every master navigation entry', () => {
  const html = fs.readFileSync(path.join(publicDir, 'email-templates.html'), 'utf8');
  const nav = html.match(/<nav class="nav-menu">([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav);
  const links = Array.from(nav.matchAll(/<a\b([^>]+)>/g), match => link(match[1].match(/href="([^"]+)"/)![1], match[1].match(/target="([^"]+)"/)?.[1]));
  const view = fixture(links);
  assert.deepEqual(paths(view.menu).filter(href => masterPaths.includes(href)), masterPaths);
  assert.equal(view.menu.querySelector('a[href="/thinkpro-admin/email-templates"]')?.className, 'nav-item active');
});

test('repeated adoption preserves custom links and targets while repairing all missing entries', () => {
  const stores = link('https://support.example.test/thinkpro-admin/stores?view=all', '_blank');
  const custom = link('/thinkpro-admin/custom-report', '_blank'); custom.setAttribute('data-custom', 'keep');
  const mailpit = link('/mailpit/', '_blank');
  const view = fixture([stores, custom, mailpit], '/thinkpro-admin/protection');
  view.context.adminFrame('/thinkpro-admin/protection');
  view.context.adminFrame('/thinkpro-admin/settings');
  view.context.adminFrame('/thinkpro-admin/protection');
  for (const route of masterPaths) assert.equal(paths(view.menu).filter(href => href === route).length, 1, route);
  assert.deepEqual(paths(view.menu).filter(href => masterPaths.includes(href)), masterPaths);
  assert.equal(view.menu.querySelector('a[href="/thinkpro-admin/protection"]')?.className, 'nav-item active');
  assert.equal(view.menu.querySelector('a[href="/thinkpro-admin/settings"]')?.className, 'nav-item');
  assert.equal(view.menu.children.includes(stores), true);
  assert.equal(stores.href, 'https://support.example.test/thinkpro-admin/stores?view=all');
  assert.equal(stores.getAttribute('target'), '_blank');
  assert.equal(view.menu.children.includes(custom), true);
  assert.equal(custom.getAttribute('data-custom'), 'keep');
  assert.equal(view.menu.children.includes(mailpit), true);
});

test('new shells expose every master link and all destinations have protected page files', () => {
  const view = fixture([], '/thinkpro-admin/protection', true);
  view.context.adminFrame('/thinkpro-admin/protection');
  for (const route of masterPaths) {
    assert.equal(view.app.innerHTML.split('href="' + route + '"').length - 1, 1, route);
    const file = ADMIN_PAGE_FILES.get(route);
    assert.ok(file, route + ' must be a protected admin route');
    assert.ok(fs.existsSync(path.join(publicDir, file)), file + ' must exist');
  }
  assert.match(view.app.innerHTML, /class="nav-item active" href="\/thinkpro-admin\/protection"/);
});
