'use client';
/* ============================================================================
 *  Voces de la nube (Edge · Microsoft), en formato banco de pruebas.
 *
 *  QUÉ REEMPLAZA Y POR QUÉ: el «Estudio de voz» era un avatar de 150 px que movía la boca
 *  mientras sonaba el audio. Se veía simpático y costaba media pantalla para no decir
 *  nada: la pregunta real, cuando alguien entra acá, es «¿cuál de estas voces pongo?», y
 *  eso se contesta COMPARANDO — escuchar tres seguidas con el mismo texto. El avatar
 *  empujaba la lista hacia abajo y obligaba a hacer scroll entre una voz y la siguiente,
 *  que es justo lo que impide comparar.
 *
 *  Ahora: una barra de reproducción fija arriba (el texto de prueba, qué está sonando,
 *  parar) y debajo una grilla densa con scroll propio. La lista no crece contra la
 *  página: crece adentro de su tarjeta.
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Card, Group, Text, Badge, ThemeIcon, SimpleGrid, TextInput, ActionIcon, Tooltip, ScrollArea, SegmentedControl, Loader, Box } from '@mantine/core';
import { IconPlayerPlay, IconPlayerStop, IconStar, IconStarFilled, IconSearch, IconInfoCircle } from '@tabler/icons-react';
import { IcoNube, IcoOnda } from './IaIcons';
import { api, apiGet, apiPost } from './api';
import { toast } from './notify';

const FLAG = { UY: '🇺🇾', AR: '🇦🇷', MX: '🇲🇽', CO: '🇨🇴', CL: '🇨🇱', PE: '🇵🇪', VE: '🇻🇪', ES: '🇪🇸', US: '🇺🇸' };
const CCNAME = { UY: 'Uruguay', AR: 'Argentina', MX: 'México', CO: 'Colombia', CL: 'Chile', PE: 'Perú', VE: 'Venezuela', ES: 'España', US: 'EE.UU.' };
function meta(v) {
  const m = /^([a-z]{2})-([A-Z]{2})-([A-Za-z]+)Neural/.exec(v.key) || [];
  const cc = m[2] || '';
  const name = m[3] || v.label;
  const female = /femenina|Valentina|Elena|Dalia|Salome|Catalina|Camila|Paola/i.test(v.label + ' ' + name);
  return { ...v, cc, name, gender: female ? 'f' : 'm', flag: FLAG[cc] || '🌐', country: CCNAME[cc] || cc };
}

export default function VocesNube() {
  const [voces, setVoces] = useState(null);
  const [porDefecto, setPorDefecto] = useState('');
  const [texto, setTexto] = useState('Hola, gracias por comunicarse. ¿En qué puedo ayudarle?');
  const [filtro, setFiltro] = useState('');
  const [ambito, setAmbito] = useState('uy');
  const [sonando, setSonando] = useState(null);      // {key, label}
  const [cargandoAudio, setCargandoAudio] = useState(null);
  const audioRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const v = await apiGet('/voz/voices');
        setVoces((v.edge || []).map(meta));
        setPorDefecto(v.default || '');
      } catch (_) { setVoces([]); }
      try { const c = await apiGet('/voz/config'); if (c.default_voice) setPorDefecto(c.default_voice); } catch (_) {}
    })();
  }, []);

  async function reproducir(v) {
    if (sonando?.key === v.key) return parar();
    setCargandoAudio(v.key);
    try {
      const r = await api('/voz/test', { method: 'POST', body: { text: texto, voice: v.key }, raw: true });
      const u = URL.createObjectURL(await r.blob());
      setSonando({ key: v.key, label: v.name + ' · ' + v.country });
      if (audioRef.current) { audioRef.current.src = u; await audioRef.current.play().catch(() => {}); }
    } catch (e) { toast('No se pudo generar el audio', 'bad', { description: e.message }); setSonando(null); }
    setCargandoAudio(null);
  }
  function parar() {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    setSonando(null);
  }
  async function fijar(v) {
    setPorDefecto(v.key);
    try { await apiPost('/voz/config', { default_voice: v.key }); toast('Voz por defecto: ' + v.name, 'ok'); }
    catch (e) { toast('No se pudo fijar la voz', 'bad', { description: e.message }); }
  }

  const lista = (voces || [])
    .filter(v => ambito === 'todas' || (ambito === 'uy' ? v.cc === 'UY' : v.cc !== 'UY'))
    .filter(v => !filtro || (v.name + ' ' + v.country + ' ' + v.key).toLowerCase().includes(filtro.toLowerCase()));
  const uyCount = (voces || []).filter(v => v.cc === 'UY').length;

  return (
    <Card withBorder radius="lg" padding="md">
      <Group justify="space-between" wrap="nowrap" mb="sm">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" color="blue" size={38} radius="md"><IcoNube size={21} activo={!!sonando} /></ThemeIcon>
          <div>
            <Text fw={700} fz="sm" lh={1.2}>Voces de la nube</Text>
            <Text fz={11} c="dimmed">Neuronales de Microsoft · gratis, pero necesitan internet</Text>
          </div>
        </Group>
        <Badge variant="light" color="gray">{voces === null ? '…' : voces.length}</Badge>
      </Group>

      {/* Barra de prueba: el mismo texto para todas, que es lo que permite comparar. */}
      <Group gap="xs" wrap="nowrap" mb="sm" align="center">
        <TextInput style={{ flex: 1 }} size="sm" value={texto} onChange={e => setTexto(e.currentTarget.value)}
          placeholder="Texto de prueba" leftSection={sonando ? <IcoOnda size={15} activo /> : <IconPlayerPlay size={14} style={{ opacity: .5 }} />} />
        {sonando
          ? <Tooltip label="Detener"><ActionIcon variant="light" color="red" size={36} onClick={parar}><IconPlayerStop size={16} /></ActionIcon></Tooltip>
          : null}
      </Group>

      <Group gap="xs" wrap="nowrap" mb="xs">
        <SegmentedControl size="xs" value={ambito} onChange={setAmbito} data={[
          { value: 'uy', label: '🇺🇾 Uruguay' + (uyCount ? ' (' + uyCount + ')' : '') },
          { value: 'latam', label: '🌎 Latinoamérica' },
          { value: 'todas', label: 'Todas' },
        ]} />
        <TextInput size="xs" placeholder="Buscar…" value={filtro} onChange={e => setFiltro(e.currentTarget.value)} leftSection={<IconSearch size={13} />} style={{ flex: 1 }} />
      </Group>

      {voces === null ? <Group justify="center" py="lg"><Loader size="sm" /></Group>
        : !lista.length ? <Text size="sm" c="dimmed" ta="center" py="lg">No hay voces que coincidan.</Text>
          : (
            /* Altura fija: la lista crece ADENTRO, no contra la página. */
            <ScrollArea.Autosize mah={268} type="auto" offsetScrollbars>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={6}>
                {lista.map(v => {
                  const activo = sonando?.key === v.key;
                  const fijada = porDefecto === v.key;
                  return (
                    <Box key={v.key} onClick={() => reproducir(v)}
                      style={{
                        cursor: 'pointer', borderRadius: 8, padding: '6px 8px',
                        border: '1px solid var(--mantine-color-default-border)',
                        background: activo ? 'var(--mantine-color-blue-light)' : undefined,
                        transition: 'background .12s',
                      }}>
                      <Group gap={8} wrap="nowrap" justify="space-between">
                        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                          <Text fz={17} lh={1}>{v.flag}</Text>
                          <div style={{ minWidth: 0 }}>
                            <Group gap={4} wrap="nowrap">
                              <Text fz="sm" fw={600} truncate>{v.name}</Text>
                              {fijada && <Tooltip label="Voz por defecto de la central"><IconStarFilled size={11} style={{ color: 'var(--mantine-color-yellow-6)', flexShrink: 0 }} /></Tooltip>}
                            </Group>
                            <Text fz={10.5} c="dimmed" truncate>{v.country} · {v.gender === 'f' ? 'femenina' : 'masculina'}</Text>
                          </div>
                        </Group>
                        <Group gap={2} wrap="nowrap">
                          {!fijada && (
                            <Tooltip label="Usar por defecto">
                              <ActionIcon variant="subtle" color="yellow" size="sm" onClick={e => { e.stopPropagation(); fijar(v); }}><IconStar size={14} /></ActionIcon>
                            </Tooltip>
                          )}
                          <ThemeIcon size={26} radius="xl" variant={activo ? 'filled' : 'light'} color="blue">
                            {cargandoAudio === v.key ? <Loader size={11} color="white" />
                              : activo ? <IconPlayerStop size={13} /> : <IconPlayerPlay size={13} />}
                          </ThemeIcon>
                        </Group>
                      </Group>
                    </Box>
                  );
                })}
              </SimpleGrid>
            </ScrollArea.Autosize>
          )}

      <Group gap={6} mt="sm" wrap="nowrap">
        <IconInfoCircle size={13} style={{ opacity: .5, flexShrink: 0 }} />
        <Text fz={11} c="dimmed">
          La estrella fija la voz por defecto de toda la central. Estas voces las sintetiza Microsoft: si el enlace se cae, la central
          usa las Piper de <b>Motor local</b>.
        </Text>
      </Group>
      <audio ref={audioRef} onEnded={() => setSonando(null)} style={{ display: 'none' }} />
    </Card>
  );
}
