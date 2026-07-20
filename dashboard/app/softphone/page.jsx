'use client';
import { useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, TextInput, PasswordInput, Switch, Badge, SimpleGrid, ActionIcon, Anchor } from '@mantine/core';
import { IconPhone, IconPhoneOff, IconMicrophone, IconMicrophoneOff, IconPhoneIncoming, IconBackspace, IconExternalLink } from '@tabler/icons-react';
import { useSoftphone } from '../useSoftphone';
import { toast } from '../notify';
export default function Softphone() {
  const sp = useSoftphone();
  const [ext, setExt] = useState(''); const [pass, setPass] = useState(''); const [video, setVideo] = useState(false); const [dial, setDial] = useState('');
  const inCall = !!sp.call;
  async function doConnect() { try { await sp.connect(ext, pass, video); toast('Conectado como ' + ext, 'ok'); } catch (e) { toast('Error: ' + e.message, 'bad'); } }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div><Title order={2}>Softphone WebRTC</Title><Text c="dimmed">Llamá desde el navegador · audio y video</Text></div>
        <Anchor href="/phone" target="_blank"><Button variant="light" leftSection={<IconExternalLink size={16} />}>Abrir softphone (PWA)</Button></Anchor>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group justify="space-between" mb="md"><Text fw={600}>Conexión</Text>
            <Badge color={sp.reg === 'registered' ? 'teal' : sp.reg === 'connecting' ? 'yellow' : 'gray'} variant="light">
              {sp.reg === 'registered' ? 'Registrado' : sp.reg === 'connecting' ? 'Conectando…' : 'Desconectado'}</Badge></Group>
          {sp.reg !== 'registered' ? (
            <Stack>
              <TextInput label="Extensión WebRTC" placeholder="9100" value={ext} onChange={e => setExt(e.target.value)} />
              <PasswordInput label="Contraseña SIP" value={pass} onChange={e => setPass(e.target.value)} />
              <Switch label="Habilitar video" checked={video} onChange={e => setVideo(e.currentTarget.checked)} />
              <Button onClick={doConnect} loading={sp.reg === 'connecting'}>Conectar</Button>
              <Text size="xs" c="dimmed">La sesión persiste al recargar (F5). Demo: 9100.</Text>
            </Stack>
          ) : (
            <Stack>
              <Group><Text size="sm" c="dimmed">Extensión</Text><Badge size="lg">{sp.creds?.ext}</Badge>
                <Button size="xs" variant="subtle" color="red" onClick={sp.disconnect} ml="auto">Desconectar</Button></Group>
              <Group gap="xs"><TextInput style={{ flex: 1 }} placeholder="Número a marcar" value={dial} onChange={e => setDial(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sp.placeCall(dial); }} size="md" />
                <ActionIcon variant="subtle" size="lg" onClick={() => setDial(d => d.slice(0, -1))}><IconBackspace size={20} /></ActionIcon></Group>
              <SimpleGrid cols={3} spacing="xs">{keys.map(k => <Button key={k} variant="default" size="md" onClick={() => { sp.tone(k); setDial(d => d + k); }}>{k}</Button>)}</SimpleGrid>
              {!inCall ? <Button color="teal" leftSection={<IconPhone size={18} />} onClick={() => sp.placeCall(dial)} disabled={!dial}>Llamar</Button> :
                <Group grow><Button color="red" leftSection={<IconPhoneOff size={18} />} onClick={sp.hangup}>Colgar</Button>
                  <Button variant={sp.muted ? 'filled' : 'default'} color={sp.muted ? 'orange' : 'gray'} leftSection={sp.muted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />} onClick={sp.toggleMute}>{sp.muted ? 'Silenciado' : 'Silenciar'}</Button></Group>}
              {inCall && <Badge variant="dot" color={sp.call === 'Established' ? 'teal' : 'yellow'}>{sp.call === 'Established' ? 'En llamada' : sp.call}</Badge>}
            </Stack>
          )}
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Video</Text>
          <div style={{ position: 'relative', background: '#0b0f1a', borderRadius: 12, overflow: 'hidden', aspectRatio: '16/9' }}>
            <video ref={sp.remoteVideoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <video ref={sp.localVideoRef} autoPlay playsInline muted style={{ position: 'absolute', right: 10, bottom: 10, width: '28%', borderRadius: 8, border: '2px solid #fff' }} />
          </div>
          <audio ref={sp.audioRef} autoPlay />
        </Card>
      </SimpleGrid>
      {sp.incoming &&
        <Card withBorder radius="lg" padding="lg" shadow="md" style={{ borderColor: 'var(--mantine-color-teal-5)' }}>
          <Group justify="space-between"><Group><IconPhoneIncoming color="var(--mantine-color-teal-6)" /><Text fw={600}>Llamada entrante</Text></Group>
            <Group><Button color="teal" onClick={sp.acceptIncoming}>Atender</Button><Button color="red" variant="light" onClick={sp.rejectIncoming}>Rechazar</Button></Group></Group>
        </Card>}
    </Stack>
  );
}
