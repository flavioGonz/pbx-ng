'use client';
import { useEffect, useState } from 'react';
import { Card, Title, Text, Stack, SimpleGrid, Group, Badge, Tabs, Button, Skeleton, Select, TextInput, PasswordInput, NumberInput, Switch, ThemeIcon, Divider, Table, ActionIcon, FileButton, Tooltip, Code, Alert } from '@mantine/core';
import { IconRefresh, IconMail, IconDeviceFloppy, IconSend, IconMicrophone2, IconUpload, IconTrash, IconServer2, IconAdjustments, IconBrandTelegram, IconBrandWhatsapp, IconPlugConnected, IconInfoCircle } from '@tabler/icons-react';
import { toast } from '../notify';
import ModulesPanel from '../ModulesPanel';
const STMAP = { ok: ['teal', 'Activo'], pending: ['yellow', 'Pendiente'], optional: ['gray', 'Opcional'], down: ['red', 'Caído'], off: ['gray', 'Inactivo'] };

export default function Configuracion() {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [mails, setMails] = useState([]); const [tid, setTid] = useState(null); const [mform, setMform] = useState({}); const [msaving, setMsaving] = useState(false); const [testTo, setTestTo] = useState('');
  const [prompts, setPrompts] = useState([]); const [pname, setPname] = useState(''); const [pup, setPup] = useState(false);
  const [ints, setInts] = useState({}); const [intForm, setIntForm] = useState({ telegram: {}, whatsapp: {} });
  async function load() { setLoading(true); try { setData(await fetch('/backend/api/system').then(r => r.json())); } catch (_) { setData(null); } setLoading(false); }
  async function loadMail() { try { const d = await fetch('/backend/api/email/config').then(r => r.json()); const arr = Array.isArray(d) ? d : []; setMails(arr); if (arr.length && tid == null) { setTid(String(arr[0].tenant_id)); setMform(arr[0]); } } catch (_) {} }
  async function loadPrompts() { try { const d = await fetch('/backend/api/prompts').then(r => r.json()); setPrompts(Array.isArray(d) ? d : []); } catch (_) {} }
  async function loadInts() { try { const d = await fetch('/backend/api/integrations').then(r => r.json()); const m = {}; (Array.isArray(d) ? d : []).forEach(x => m[x.type] = x); setInts(m); } catch (_) {} }
  useEffect(() => { load(); loadMail(); loadPrompts(); loadInts(); }, []);
  const setIF = (t, k, v) => setIntForm(f => ({ ...f, [t]: { ...f[t], [k]: v } }));
  async function saveInt(type) { const body = { ...intForm[type], enabled: ints[type]?.enabled }; const r = await fetch('/backend/api/integrations/' + type, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error al guardar' : 'Integración guardada', r.error ? 'bad' : 'ok'); setIntForm(f => ({ ...f, [type]: {} })); loadInts(); }
  async function toggleInt(type, en) { setInts(m => ({ ...m, [type]: { ...m[type], enabled: en } })); await fetch('/backend/api/integrations/' + type, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: en }) }).catch(() => {}); loadInts(); }
  async function testInt(type) { const r = await fetch('/backend/api/integrations/' + type + '/test', { method: 'POST' }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Falló: ' + (r.error || '') : 'Mensaje de prueba enviado', r.error ? 'bad' : 'ok'); }
  function pickTenant(v) { setTid(v); const m = mails.find(x => String(x.tenant_id) === String(v)); setMform(m || { tenant_id: v }); }
  const setM = (k, val) => setMform(f => ({ ...f, [k]: val }));
  async function saveMail() { setMsaving(true); const r = await fetch('/backend/api/email/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mform, tenant_id: tid }) }).then(x => x.json()).catch(() => ({ error: 1 })); setMsaving(false); toast(r.error ? 'Error al guardar' : 'Email guardado', r.error ? 'bad' : 'ok'); loadMail(); }
  async function testMail() { if (!testTo) return; const r = await fetch('/backend/api/email/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_id: tid, to: testTo }) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error: ' + (r.error || '') : 'Email de prueba enviado', r.error ? 'bad' : 'ok'); }
  async function uploadPrompt(file) {
    if (!file) return;
    const name = (pname || file.name.replace(/\.[^.]+$/, '')).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!name) { toast('Poné un nombre válido', 'bad'); return; }
    const fmt = (file.name.split('.').pop() || 'wav').toLowerCase(); setPup(true);
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
    const r = await fetch('/backend/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, format: fmt, data: b64 }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setPup(false); toast(r.error ? 'Error al subir' : 'Audio ' + (r.name || name) + ' subido', r.error ? 'bad' : 'ok'); setPname(''); loadPrompts();
  }
  async function delPrompt(id) { if (!confirm('¿Eliminar este audio?')) return; await fetch('/backend/api/prompts/' + id, { method: 'DELETE' }); toast('Audio eliminado', 'info'); loadPrompts(); }

  const comps = data?.components || [];
  const groups = [...new Set(comps.map(c => c.group))];

  return (
    <Stack gap="lg">
      <Group justify="space-between"><div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-pbx-5),var(--mantine-color-pbx-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'pbx.5', to: 'pbx.8', deg: 135 }}><IconAdjustments size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Configuración</Title><Text c="dimmed" size="sm">Componentes, email y audios · Asterisk {data?.asterisk || ''}</Text></div></div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Recargar</Button></Group>

      <Tabs defaultValue="componentes" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="modulos" leftSection={<IconAdjustments size={16} />}>Módulos</Tabs.Tab>
          <Tabs.Tab value="componentes" leftSection={<IconServer2 size={16} />}>Componentes</Tabs.Tab>
          <Tabs.Tab value="email" leftSection={<IconMail size={16} />}>Email por empresa</Tabs.Tab>
          <Tabs.Tab value="audios" leftSection={<IconMicrophone2 size={16} />}>Audios</Tabs.Tab>
          <Tabs.Tab value="integraciones" leftSection={<IconPlugConnected size={16} />}>Integraciones</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="modulos"><ModulesPanel /></Tabs.Panel>

        <Tabs.Panel value="componentes">
          {loading ?
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={74} radius="md" />)}</SimpleGrid> :
            groups.length > 0 &&
            <Tabs defaultValue={groups[0]} variant="default" radius="md">
              <Tabs.List mb="md">{groups.map(g => <Tabs.Tab key={g} value={g}>{g}</Tabs.Tab>)}</Tabs.List>
              {groups.map(g => (
                <Tabs.Panel key={g} value={g}>
                  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                    {comps.filter(c => c.group === g).map(c => {
                      const [col, lbl] = STMAP[c.status] || ['gray', c.status];
                      return <Card key={c.name} withBorder radius="md" padding="md" shadow="xs"><Group justify="space-between" wrap="nowrap">
                        <div><Text fw={600} size="sm">{c.name}</Text><Text size="xs" c="dimmed">{c.detail}</Text></div>
                        <Badge color={col} variant="light" radius="sm">{lbl}</Badge></Group></Card>;
                    })}
                  </SimpleGrid>
                </Tabs.Panel>
              ))}
              <Tabs.Panel value="integraciones">
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            <Card withBorder radius="lg" padding="lg" shadow="sm">
              <Group justify="space-between" mb="md">
                <Group gap="xs"><ThemeIcon variant="light" color="blue" radius="md"><IconBrandTelegram size={18} /></ThemeIcon><Text fw={600}>Telegram</Text>{ints.telegram?.configured && <Badge variant="light" color="teal">Configurado</Badge>}</Group>
                <Switch checked={!!ints.telegram?.enabled} onChange={e => toggleInt('telegram', e.currentTarget.checked)} />
              </Group>
              <Text size="xs" c="dimmed" mb="sm">Notificaciones de llamadas perdidas a un chat de Telegram. Creá un bot con @BotFather y pegá su token.</Text>
              <Stack gap="sm">
                <PasswordInput label="Token del bot" placeholder={ints.telegram?.configured ? '•••••• (guardado, dejá vacío para mantener)' : '123456:ABC-DEF…'} value={intForm.telegram?.token || ''} onChange={e => setIF('telegram', 'token', e.target.value)} />
                <TextInput label="Chat ID" placeholder="-1001234567890" value={intForm.telegram?.chat_id ?? ints.telegram?.chat_id ?? ''} onChange={e => setIF('telegram', 'chat_id', e.target.value)} />
                <Group><Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => saveInt('telegram')}>Guardar</Button><Button variant="light" leftSection={<IconSend size={16} />} onClick={() => testInt('telegram')} disabled={!ints.telegram?.configured}>Probar</Button></Group>
              </Stack>
            </Card>
            <Card withBorder radius="lg" padding="lg" shadow="sm">
              <Group justify="space-between" mb="md">
                <Group gap="xs"><ThemeIcon variant="light" color="green" radius="md"><IconBrandWhatsapp size={18} /></ThemeIcon><Text fw={600}>WhatsApp</Text>{ints.whatsapp?.configured && <Badge variant="light" color="teal">Configurado</Badge>}</Group>
                <Switch checked={!!ints.whatsapp?.enabled} onChange={e => toggleInt('whatsapp', e.currentTarget.checked)} />
              </Group>
              <Text size="xs" c="dimmed" mb="sm">Vía instancia openwa (Docker). Indicá la URL de su API REST, la api_key y el destinatario (número@c.us o id de grupo).</Text>
              <Stack gap="sm">
                <TextInput label="URL de la API openwa" placeholder="http://172.26.20.x:8002" value={intForm.whatsapp?.url ?? ints.whatsapp?.url ?? ''} onChange={e => setIF('whatsapp', 'url', e.target.value)} />
                <PasswordInput label="API key" placeholder={ints.whatsapp?.has_apikey ? '•••••• (guardada, dejá vacío para mantener)' : 'tu api_key'} value={intForm.whatsapp?.apikey || ''} onChange={e => setIF('whatsapp', 'apikey', e.target.value)} />
                <TextInput label="Destinatario" placeholder="59899123456@c.us" value={intForm.whatsapp?.to ?? ints.whatsapp?.to ?? ''} onChange={e => setIF('whatsapp', 'to', e.target.value)} />
                <Group><Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => saveInt('whatsapp')}>Guardar</Button><Button variant="light" leftSection={<IconSend size={16} />} onClick={() => testInt('whatsapp')} disabled={!ints.whatsapp?.configured}>Probar</Button></Group>
              </Stack>
            </Card>
          </SimpleGrid>
        </Tabs.Panel>
      </Tabs>}
        </Tabs.Panel>

        <Tabs.Panel value="email">
          <Card withBorder radius="lg" padding="lg" shadow="sm">
            <Group gap="sm" mb="md"><ThemeIcon variant="light" color="pbx"><IconMail size={18} /></ThemeIcon><Text fw={600}>Servidor de correo (SMTP) por empresa</Text></Group>
            <Alert mb="md" variant="light" color="blue" icon={<IconInfoCircle size={18} />} title="Gmail / Google Workspace">Si la cuenta tiene verificacion en 2 pasos, la contrasena normal NO sirve: genera una <b>Contrasena de aplicacion</b> en myaccount.google.com/apppasswords y pegala en Contrasena. Para Gmail usa <Code>smtp.gmail.com</Code>, puerto <Code>465</Code> con SSL/TLS activado.</Alert>
            {mails.length === 0 ? <Text c="dimmed" size="sm">Cargando empresas…</Text> :
              <Stack gap="sm">
                <Group grow align="flex-end">
                  <Select label="Empresa" value={tid} onChange={pickTenant} data={mails.map(m => ({ value: String(m.tenant_id), label: m.name || ('Empresa ' + m.tenant_id) }))} />
                  <Switch label="Email activo" checked={!!mform.enabled} onChange={e => setM('enabled', e.currentTarget.checked)} />
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput label="Servidor SMTP" placeholder="smtp.gmail.com" value={mform.host || ''} onChange={e => setM('host', e.target.value)} />
                  <NumberInput label="Puerto" placeholder="587" value={mform.port || 587} onChange={v => setM('port', v || 587)} />
                  <TextInput label="Usuario" placeholder="cuenta@empresa.com" value={mform.username || ''} onChange={e => setM('username', e.target.value)} />
                  <PasswordInput label="Contraseña" placeholder={mform.has_password ? '•••••• (guardada)' : ''} value={mform.password || ''} onChange={e => setM('password', e.target.value)} />
                  <TextInput label="Remitente (From)" placeholder="PBX IES <noreply@empresa.com>" value={mform.from_addr || ''} onChange={e => setM('from_addr', e.target.value)} />
                  <Switch label="SSL/TLS directo (465)" mt="lg" checked={!!mform.secure} onChange={e => setM('secure', e.currentTarget.checked)} />
                </SimpleGrid>
                <Group justify="space-between">
                  <Group gap="xs">
                    <TextInput size="xs" placeholder="probar enviando a…" leftSection={<IconMail size={13} />} value={testTo} onChange={e => setTestTo(e.target.value)} w={220} />
                    <Button size="xs" variant="light" leftSection={<IconSend size={14} />} disabled={!testTo} onClick={testMail}>Probar</Button>
                  </Group>
                  <Button leftSection={<IconDeviceFloppy size={16} />} loading={msaving} onClick={saveMail}>Guardar email</Button>
                </Group>
              </Stack>}
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="audios">
          <Card withBorder radius="lg" padding="lg" shadow="sm">
            <Group justify="space-between" mb="md">
              <Group gap="sm"><ThemeIcon variant="light" color="grape"><IconMicrophone2 size={18} /></ThemeIcon><Text fw={600}>Audios / Prompts personalizados</Text></Group>
              <Group gap="sm">
                <TextInput placeholder="nombre (ej: bienvenida)" value={pname} onChange={e => setPname(e.target.value)} w={200} size="sm" />
                <FileButton onChange={uploadPrompt} accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.gsm">
                  {(props) => <Button {...props} loading={pup} leftSection={<IconUpload size={16} />} size="sm">Subir audio</Button>}
                </FileButton>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mb="sm">Usalos en el IVR o dialplan como <Code>custom/&lt;nombre&gt;</Code>. Recomendado: WAV 8 kHz mono. Los prompts del sistema ya están en español.</Text>
            {prompts.length === 0 ? <Text c="dimmed" size="sm" ta="center" py="md">Sin audios personalizados. Subí uno para empezar.</Text> :
              <Table striped highlightOnHover verticalSpacing="xs">
                <Table.Thead><Table.Tr><Table.Th>Nombre</Table.Th><Table.Th>Formato</Table.Th><Table.Th>Tamaño</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Reproducir</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{prompts.map(p => (
                  <Table.Tr key={p.id}>
                    <Table.Td ff="monospace" fw={600}>custom/{p.name}</Table.Td>
                    <Table.Td>{p.format}</Table.Td>
                    <Table.Td>{p.bytes ? (p.bytes / 1024).toFixed(0) + ' KB' : '—'}</Table.Td>
                    <Table.Td>{p.synced_at ? <Badge size="sm" variant="light" color="teal">En Asterisk</Badge> : <Badge size="sm" variant="light" color="yellow">Sincronizando…</Badge>}</Table.Td>
                    <Table.Td><audio controls preload="none" style={{ height: 28, maxWidth: 180 }} src={'/backend/api/prompts/' + p.id + '/audio'} /></Table.Td>
                    <Table.Td ta="right"><Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => delPrompt(p.id)}><IconTrash size={16} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>}
          </Card>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
