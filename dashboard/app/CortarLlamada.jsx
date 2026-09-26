'use client';
import { useState } from 'react';
import { Button, Modal, Stack, Text, Group, ThemeIcon, Code } from '@mantine/core';
import { IconPhoneOff } from '@tabler/icons-react';
import { apiPost } from './api';
import { toast } from './notify';

/* ============================================================================
 *  Cortar una llamada desde el panel.
 *
 *  Existe porque faltaba lo obvio: se veían las llamadas en curso y no había forma de
 *  terminar ninguna. Cuando una quedaba trabada —la aplicación de voz se reinició y el
 *  canal siguió vivo— el interno quedaba ocupado y la única salida era entrar por SSH a
 *  la consola de Asterisk.
 *
 *  Pregunta antes de cortar, siempre: del otro lado hay alguien hablando. Y dice a QUIÉN
 *  va a cortar, no «¿confirma?», porque en una tabla de doce filas uno se equivoca de fila.
 * ==========================================================================*/
export default function CortarLlamada({ id, quien, canal, size = 'compact-sm', onHecho }) {
  const [abierto, setAbierto] = useState(false);
  const [yendo, setYendo] = useState(false);

  async function cortar() {
    setYendo(true);
    try {
      const r = await apiPost('/calls/' + encodeURIComponent(id) + '/hangup');
      setAbierto(false);
      /* `via: ami` = ARI no pudo y hubo que forzarlo. Se dice, porque significa que algo
       * anda raro en la central aunque la llamada haya cortado. */
      toast(r && r.via === 'ami' ? 'Llamada cortada (hubo que forzarla)' : 'Llamada cortada', 'ok');
      if (onHecho) onHecho();
    } catch (e) {
      toast(e.message, 'bad');
    } finally { setYendo(false); }
  }

  return (
    <>
      <Button size={size} variant="light" color="red" leftSection={<IconPhoneOff size={14} />}
        onClick={() => setAbierto(true)} disabled={!id}>Cortar</Button>

      <Modal opened={abierto} onClose={() => setAbierto(false)} centered radius="lg" withCloseButton={false}>
        <Stack>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={42} radius="md" variant="light" color="red"><IconPhoneOff size={22} /></ThemeIcon>
            <div>
              <Text fw={800} lh={1.15}>Cortar la llamada de {quien || 'este canal'}</Text>
              <Text size="xs" c="dimmed">Se corta ahora mismo, sin aviso para quien está hablando.</Text>
            </div>
          </Group>
          {canal ? <Code block fz={11}>{canal}</Code> : null}
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setAbierto(false)}>Cancelar</Button>
            <Button color="red" loading={yendo} onClick={cortar} leftSection={<IconPhoneOff size={16} />}>Cortar llamada</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
