--
-- PostgreSQL database dump
--

\restrict C945lEyFzExNUgp9bwjuSVQmwlCvH9sZmHQ0yXaTkRAgfEw56vHBRdGcagZG4Sk

-- Dumped from database version 15.18 (Debian 15.18-0+deb12u1)
-- Dumped by pg_dump version 15.18 (Debian 15.18-0+deb12u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: version; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.version (id, table_name, table_version) FROM stdin;
1	uacreg	5
2	secfilter	1
3	dr_gateways	3
4	dr_rules	3
5	dr_gw_lists	1
6	dr_groups	2
\.


--
-- Name: version_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.version_id_seq', 6, true);


--
-- PostgreSQL database dump complete
--

\unrestrict C945lEyFzExNUgp9bwjuSVQmwlCvH9sZmHQ0yXaTkRAgfEw56vHBRdGcagZG4Sk

