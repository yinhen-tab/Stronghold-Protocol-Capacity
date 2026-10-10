import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CAPACITIES } from '../../shared/constants.js';
import { emptyLobbyDiscovery } from '../../public/js/lobbyDiscovery.js';
import { Button } from '../../public/js/ui/components.js';
import { LobbyOnlinePill, LobbyDiscoveryPanel, LobbyRoomRow, LobbyRoomList } from '../../public/js/ui/lobbyDiscovery.js';

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  yield* walk(node.props?.children);
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text(node.props?.children) : String(node);
};

test('preference capacities use the same canonical values as room creation and default is unrestricted', () => {
  const picked = [];
  const panel = LobbyDiscoveryPanel({ state: emptyLobbyDiscovery(), connected: true, capacity: null, onCapacity: (n) => picked.push(n) });
  const nodes = [...walk(panel)];
  const select = nodes.find((n) => n.type === 'select');
  assert.equal(select.props.value, '');
  assert.deepEqual([...walk(select)].filter((n) => n.type === 'option').map((n) => n.props.value), ['', ...ROOM_CAPACITIES]);
  select.props.onChange({ currentTarget: { value: '20' } });
  select.props.onChange({ currentTarget: { value: '' } });
  assert.deepEqual(picked, [20, null]);
});

const room = { code: 'ABCD', mode: 'coop', difficulty: 'FUNNY', capacity: 20, playerCount: 10, humanCount: 2, botCount: 8, inMatch: false, joinable: true, hostOnline: false };

test('directory exposes room code, capacity, AI occupancy and host-disconnected admission without replacing AI', () => {
  const joined = [];
  const row = LobbyRoomRow({ room, connected: true, busy: false, onJoin: (code) => joined.push(code) });
  const join = [...walk(row)].find((node) => node.type === Button);
  assert.equal(row.props['data-room-code'], 'ABCD');
  assert.match(text(row), /ABCD/);
  assert.match(text(row), /10 \/ 20 席/);
  assert.match(text(row), /2 个真人 · 8 个 AI/);
  assert.match(text(row), /房主离线/);
  assert.equal(join.props.disabled, false);
  join.props.onClick();
  assert.deepEqual(joined, ['ABCD']);
});

test('in-progress and solo rooms expose no entry button; full waiting rooms cannot be joined', () => {
  const progress = LobbyRoomRow({ room: { ...room, inMatch: true, joinable: false }, connected: true });
  assert.equal([...walk(progress)].some((node) => node.type === Button), false);
  assert.match(text(progress), /进行中/);
  const solo = LobbyRoomRow({ room: { ...room, mode: 'solo', capacity: 1, playerCount: 1, joinable: false }, connected: true });
  assert.equal([...walk(solo)].some((node) => node.type === Button), false);
  const full = LobbyRoomRow({ room: { ...room, playerCount: 20, joinable: false }, connected: true });
  assert.equal([...walk(full)].find((node) => node.type === Button).props.disabled, true);
});

test('offline lobby keeps explanatory count placeholder and disables matching and listing', () => {
  const pill = LobbyOnlinePill({ count: 100, connected: false });
  assert.equal(pill.props['aria-label'], '服务器在线人数');
  assert.match(text(pill), /在线 —/);
  assert.doesNotMatch(text(pill), /100/);
  const panel = LobbyDiscoveryPanel({ state: emptyLobbyDiscovery(), connected: false });
  const buttons = [...walk(panel)].filter((node) => node.type === Button);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((node) => node.props.disabled));
});

test('room browser distinguishes loading, empty, disconnected and error states and bounds pagination', () => {
  const state = { ...emptyLobbyDiscovery(), open: true };
  assert.match(text(LobbyRoomList({ state, connected: true })), /当前没有房间/);
  assert.match(text(LobbyRoomList({ state: { ...state, error: true }, connected: true })), /无法获取房间列表/);
  assert.match(text(LobbyRoomList({ state, connected: false })), /尚未连接到服务器/);
  const calls = [];
  const last = LobbyRoomList({ state: { ...state, page: 1, totalPages: 2 }, connected: true, onPage: (p) => calls.push(p) });
  const footerButtons = [...walk(last.props.actions)].filter((n) => n.type === Button);
  assert.equal(footerButtons[0].props.disabled, false);
  assert.equal(footerButtons[1].props.disabled, true);
  footerButtons[0].props.onClick();
  assert.deepEqual(calls, [0]);
});
