/* Lo que todas las pruebas del softphone necesitan: limpiar lo que montó Testing Library
 * entre prueba y prueba. */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
