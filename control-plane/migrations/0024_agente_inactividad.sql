-- PBX-NG · 0024 · Qué hace el agente cuando el visitante deja de hablar.
--
-- POR QUÉ NO ES UN PROMPT: un modelo de voz no tiene reloj, no sabe cuánto silencio pasó
-- y no puede colgar. Pedirle «si no contesta en 5 segundos preguntá si sigue ahí»
-- funciona a veces, y «a veces» en una portería es una llamada abierta toda la noche —
-- que además se paga por minuto— o cortada en la cara de un visitante. La escalera la
-- maneja `inactividad.js`; el modelo sólo pone la voz.
--
-- LOS TRES TIEMPOS, Y POR QUÉ SON TRES:
--   inact1_s   silencio antes de «¿sigue ahí?». Se cuenta desde que el agente TERMINA de
--              hablar, no desde que se le manda el texto.
--   inact2_s   silencio antes del segundo intento, con otra frase (la misma dos veces
--              suena a grabación trabada).
--   cierre_s   silencio antes de despedirse. Después de la despedida se corta.
-- Dos consultas antes de cortar, y no una, porque la primera se pierde seguido: el
-- visitante se dio vuelta, estaba hablando con alguien, se le cayó el teléfono.
--
-- CERO = APAGADO, y es el default para TODAS las colas y agentes que ya existen. Una
-- actualización no puede empezar a cortarle llamadas a nadie sin que lo pidan.
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS inact1_s       int  NOT NULL DEFAULT 0;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS inact2_s       int  NOT NULL DEFAULT 0;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS cierre_s       int  NOT NULL DEFAULT 0;
-- Las frases son del cliente, no nuestras: «¿sigue ahí?» no se le dice igual a un
-- visitante de portería que a alguien que llama a una mutualista. Vacío = la de fábrica.
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS inact1_text    text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS inact2_text    text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS despedida_text text;
