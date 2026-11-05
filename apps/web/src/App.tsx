import { useCallback, useEffect, useState } from 'react';
import type { Member, Persona, Room, User } from './lib/api';
import { getSession, signOut, listRooms, createRoom, getRoom } from './lib/api';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/SettingsPanel';

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [roomName, setRoomName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshRooms = useCallback(async () => {
    try {
      const rs = await listRooms();
      setRooms(rs);
      return rs;
    } catch {
      return [] as Room[];
    }
  }, []);

  // 会话 + 房间列表
  useEffect(() => {
    (async () => {
      const u = await getSession();
      setMe(u);
      setLoading(false);
      if (u) {
        const rs = await refreshRooms();
        if (rs.length && !activeId) {
          setActiveId(rs[0].id);
          setRoomName(rs[0].name);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  // 当前房间成员
  useEffect(() => {
    if (!activeId) return;
    getRoom(activeId)
      .then(({ room, members }) => {
        setMembers(members);
        setRoomName(room.name);
      })
      .catch(() => setMembers([]));
  }, [activeId]);

  async function handleSignOut() {
    await signOut();
    setMe(null);
    setRooms([]);
    setActiveId(null);
  }

  async function handleNewRoom(name: string) {
    const r = await createRoom(name);
    await refreshRooms();
    setActiveId(r.id);
    setRoomName(r.name);
  }

  function handlePersonaSaved(p: Persona) {
    setRooms((rs) => rs.map((r) => (r.is_main === 1 ? { ...r, name: p.main_room_name } : r)));
    const active = rooms.find((r) => r.id === activeId);
    if (active?.is_main === 1) setRoomName(p.main_room_name);
    setSettingsOpen(false);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-mut)]">加载中…</div>
    );
  }

  if (!me) {
    return (
      <Login
        onDone={async () => {
          const u = await getSession();
          setMe(u);
          if (u) {
            const rs = await refreshRooms();
            if (rs.length) {
              setActiveId(rs[0].id);
              setRoomName(rs[0].name);
            }
          }
        }}
      />
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        rooms={rooms}
        activeId={activeId}
        me={me}
        onSelect={(id) => {
          setActiveId(id);
          const r = rooms.find((x) => x.id === id);
          if (r) setRoomName(r.name);
        }}
        onNewRoom={handleNewRoom}
        onSignOut={handleSignOut}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {activeId ? (
        <Chat
          key={activeId}
          roomId={activeId}
          roomName={roomName}
          me={me}
          members={members}
          onMembersChanged={async () => {
            if (activeId) {
              try {
                const { members } = await getRoom(activeId);
                setMembers(members);
              } catch {}
            }
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[var(--color-mut)]">
          选择或新建一个房间
        </div>
      )}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSuccess={handlePersonaSaved}
        />
      )}
    </div>
  );
}
