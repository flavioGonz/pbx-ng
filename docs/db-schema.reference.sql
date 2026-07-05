--
-- PostgreSQL database dump
--

\restrict 61QoG27gRb3cSgQqQKNAMnE517g3NwN1IhGlFnybR7ky2aTWR699lSu8Bh2Mlei

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ast_bool_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.ast_bool_values AS ENUM (
    '0',
    '1',
    'off',
    'on',
    'false',
    'true',
    'no',
    'yes'
);


ALTER TYPE public.ast_bool_values OWNER TO pbxng;

--
-- Name: iax_encryption_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.iax_encryption_values AS ENUM (
    'yes',
    'no',
    'aes128'
);


ALTER TYPE public.iax_encryption_values OWNER TO pbxng;

--
-- Name: iax_requirecalltoken_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.iax_requirecalltoken_values AS ENUM (
    'yes',
    'no',
    'auto'
);


ALTER TYPE public.iax_requirecalltoken_values OWNER TO pbxng;

--
-- Name: iax_transfer_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.iax_transfer_values AS ENUM (
    'yes',
    'no',
    'mediaonly'
);


ALTER TYPE public.iax_transfer_values OWNER TO pbxng;

--
-- Name: moh_mode_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.moh_mode_values AS ENUM (
    'custom',
    'files',
    'mp3nb',
    'quietmp3nb',
    'quietmp3',
    'playlist'
);


ALTER TYPE public.moh_mode_values OWNER TO pbxng;

--
-- Name: pjsip_100rel_values_v2; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_100rel_values_v2 AS ENUM (
    'no',
    'required',
    'peer_supported',
    'yes'
);


ALTER TYPE public.pjsip_100rel_values_v2 OWNER TO pbxng;

--
-- Name: pjsip_auth_type_values_v2; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_auth_type_values_v2 AS ENUM (
    'md5',
    'userpass',
    'google_oauth'
);


ALTER TYPE public.pjsip_auth_type_values_v2 OWNER TO pbxng;

--
-- Name: pjsip_cid_privacy_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_cid_privacy_values AS ENUM (
    'allowed_not_screened',
    'allowed_passed_screened',
    'allowed_failed_screened',
    'allowed',
    'prohib_not_screened',
    'prohib_passed_screened',
    'prohib_failed_screened',
    'prohib',
    'unavailable'
);


ALTER TYPE public.pjsip_cid_privacy_values OWNER TO pbxng;

--
-- Name: pjsip_connected_line_method_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_connected_line_method_values AS ENUM (
    'invite',
    'reinvite',
    'update'
);


ALTER TYPE public.pjsip_connected_line_method_values OWNER TO pbxng;

--
-- Name: pjsip_direct_media_glare_mitigation_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_direct_media_glare_mitigation_values AS ENUM (
    'none',
    'outgoing',
    'incoming'
);


ALTER TYPE public.pjsip_direct_media_glare_mitigation_values OWNER TO pbxng;

--
-- Name: pjsip_dtls_setup_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_dtls_setup_values AS ENUM (
    'active',
    'passive',
    'actpass'
);


ALTER TYPE public.pjsip_dtls_setup_values OWNER TO pbxng;

--
-- Name: pjsip_dtmf_mode_values_v3; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_dtmf_mode_values_v3 AS ENUM (
    'rfc4733',
    'inband',
    'info',
    'auto',
    'auto_info'
);


ALTER TYPE public.pjsip_dtmf_mode_values_v3 OWNER TO pbxng;

--
-- Name: pjsip_incoming_call_offer_pref_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_incoming_call_offer_pref_values AS ENUM (
    'local',
    'local_first',
    'remote',
    'remote_first'
);


ALTER TYPE public.pjsip_incoming_call_offer_pref_values OWNER TO pbxng;

--
-- Name: pjsip_media_encryption_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_media_encryption_values AS ENUM (
    'no',
    'sdes',
    'dtls'
);


ALTER TYPE public.pjsip_media_encryption_values OWNER TO pbxng;

--
-- Name: pjsip_outgoing_call_offer_pref_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_outgoing_call_offer_pref_values AS ENUM (
    'local',
    'local_merge',
    'local_first',
    'remote',
    'remote_merge',
    'remote_first'
);


ALTER TYPE public.pjsip_outgoing_call_offer_pref_values OWNER TO pbxng;

--
-- Name: pjsip_redirect_method_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_redirect_method_values AS ENUM (
    'user',
    'uri_core',
    'uri_pjsip'
);


ALTER TYPE public.pjsip_redirect_method_values OWNER TO pbxng;

--
-- Name: pjsip_t38udptl_ec_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_t38udptl_ec_values AS ENUM (
    'none',
    'fec',
    'redundancy'
);


ALTER TYPE public.pjsip_t38udptl_ec_values OWNER TO pbxng;

--
-- Name: pjsip_taskprocessor_overload_trigger_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_taskprocessor_overload_trigger_values AS ENUM (
    'none',
    'global',
    'pjsip_only'
);


ALTER TYPE public.pjsip_taskprocessor_overload_trigger_values OWNER TO pbxng;

--
-- Name: pjsip_timer_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_timer_values AS ENUM (
    'forced',
    'no',
    'required',
    'yes'
);


ALTER TYPE public.pjsip_timer_values OWNER TO pbxng;

--
-- Name: pjsip_transport_method_values_v2; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_transport_method_values_v2 AS ENUM (
    'default',
    'unspecified',
    'tlsv1',
    'tlsv1_1',
    'tlsv1_2',
    'tlsv1_3',
    'sslv2',
    'sslv23',
    'sslv3'
);


ALTER TYPE public.pjsip_transport_method_values_v2 OWNER TO pbxng;

--
-- Name: pjsip_transport_protocol_values_v2; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.pjsip_transport_protocol_values_v2 AS ENUM (
    'udp',
    'tcp',
    'tls',
    'ws',
    'wss',
    'flow'
);


ALTER TYPE public.pjsip_transport_protocol_values_v2 OWNER TO pbxng;

--
-- Name: queue_autopause_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.queue_autopause_values AS ENUM (
    'yes',
    'no',
    'all'
);


ALTER TYPE public.queue_autopause_values OWNER TO pbxng;

--
-- Name: queue_strategy_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.queue_strategy_values AS ENUM (
    'ringall',
    'leastrecent',
    'fewestcalls',
    'random',
    'rrmemory',
    'linear',
    'wrandom',
    'rrordered'
);


ALTER TYPE public.queue_strategy_values OWNER TO pbxng;

--
-- Name: security_negotiation_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.security_negotiation_values AS ENUM (
    'no',
    'mediasec'
);


ALTER TYPE public.security_negotiation_values OWNER TO pbxng;

--
-- Name: sha_hash_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sha_hash_values AS ENUM (
    'SHA-1',
    'SHA-256'
);


ALTER TYPE public.sha_hash_values OWNER TO pbxng;

--
-- Name: sip_callingpres_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_callingpres_values AS ENUM (
    'allowed_not_screened',
    'allowed_passed_screen',
    'allowed_failed_screen',
    'allowed',
    'prohib_not_screened',
    'prohib_passed_screen',
    'prohib_failed_screen',
    'prohib'
);


ALTER TYPE public.sip_callingpres_values OWNER TO pbxng;

--
-- Name: sip_directmedia_values_v2; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_directmedia_values_v2 AS ENUM (
    'yes',
    'no',
    'nonat',
    'update',
    'outgoing'
);


ALTER TYPE public.sip_directmedia_values_v2 OWNER TO pbxng;

--
-- Name: sip_dtmfmode_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_dtmfmode_values AS ENUM (
    'rfc2833',
    'info',
    'shortinfo',
    'inband',
    'auto'
);


ALTER TYPE public.sip_dtmfmode_values OWNER TO pbxng;

--
-- Name: sip_progressinband_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_progressinband_values AS ENUM (
    'yes',
    'no',
    'never'
);


ALTER TYPE public.sip_progressinband_values OWNER TO pbxng;

--
-- Name: sip_session_refresher_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_session_refresher_values AS ENUM (
    'uac',
    'uas'
);


ALTER TYPE public.sip_session_refresher_values OWNER TO pbxng;

--
-- Name: sip_session_timers_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_session_timers_values AS ENUM (
    'accept',
    'refuse',
    'originate'
);


ALTER TYPE public.sip_session_timers_values OWNER TO pbxng;

--
-- Name: sip_transport_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.sip_transport_values AS ENUM (
    'udp',
    'tcp',
    'tls',
    'ws',
    'wss',
    'udp,tcp',
    'tcp,udp'
);


ALTER TYPE public.sip_transport_values OWNER TO pbxng;

--
-- Name: type_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.type_values AS ENUM (
    'friend',
    'user',
    'peer'
);


ALTER TYPE public.type_values OWNER TO pbxng;

--
-- Name: yes_no_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.yes_no_values AS ENUM (
    'yes',
    'no'
);


ALTER TYPE public.yes_no_values OWNER TO pbxng;

--
-- Name: yesno_values; Type: TYPE; Schema: public; Owner: pbxng
--

CREATE TYPE public.yesno_values AS ENUM (
    'yes',
    'no'
);


ALTER TYPE public.yesno_values OWNER TO pbxng;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version_cdr; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.alembic_version_cdr (
    version_num character varying(32) NOT NULL
);


ALTER TABLE public.alembic_version_cdr OWNER TO pbxng;

--
-- Name: alembic_version_config; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.alembic_version_config (
    version_num character varying(32) NOT NULL
);


ALTER TABLE public.alembic_version_config OWNER TO pbxng;

--
-- Name: cdr; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.cdr (
    accountcode character varying(80),
    src character varying(80),
    dst character varying(80),
    dcontext character varying(80),
    clid character varying(80),
    channel character varying(80),
    dstchannel character varying(80),
    lastapp character varying(80),
    lastdata character varying(80),
    start timestamp without time zone,
    answer timestamp without time zone,
    "end" timestamp without time zone,
    duration integer,
    billsec integer,
    disposition character varying(45),
    amaflags character varying(45),
    userfield character varying(256),
    uniqueid character varying(150),
    linkedid character varying(150),
    peeraccount character varying(80),
    sequence integer
);


ALTER TABLE public.cdr OWNER TO pbxng;

--
-- Name: dr_gateways; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.dr_gateways (
    gwid integer NOT NULL,
    type integer DEFAULT 0 NOT NULL,
    address character varying(128) NOT NULL,
    strip integer DEFAULT 0 NOT NULL,
    pri_prefix character varying(64) DEFAULT NULL::character varying,
    attrs character varying(255) DEFAULT NULL::character varying,
    description character varying(128) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.dr_gateways OWNER TO pbxng;

--
-- Name: dr_gateways_gwid_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.dr_gateways_gwid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.dr_gateways_gwid_seq OWNER TO pbxng;

--
-- Name: dr_gateways_gwid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.dr_gateways_gwid_seq OWNED BY public.dr_gateways.gwid;


--
-- Name: dr_groups; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.dr_groups (
    id integer NOT NULL,
    username character varying(64) NOT NULL,
    domain character varying(128) DEFAULT ''::character varying NOT NULL,
    groupid integer DEFAULT 0 NOT NULL,
    description character varying(128) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.dr_groups OWNER TO pbxng;

--
-- Name: dr_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.dr_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.dr_groups_id_seq OWNER TO pbxng;

--
-- Name: dr_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.dr_groups_id_seq OWNED BY public.dr_groups.id;


--
-- Name: dr_gw_lists; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.dr_gw_lists (
    id integer NOT NULL,
    gwlist character varying(255) NOT NULL,
    description character varying(128) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.dr_gw_lists OWNER TO pbxng;

--
-- Name: dr_gw_lists_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.dr_gw_lists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.dr_gw_lists_id_seq OWNER TO pbxng;

--
-- Name: dr_gw_lists_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.dr_gw_lists_id_seq OWNED BY public.dr_gw_lists.id;


--
-- Name: dr_rules; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.dr_rules (
    ruleid integer NOT NULL,
    groupid character varying(255) NOT NULL,
    prefix character varying(64) NOT NULL,
    timerec character varying(255) NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    routeid character varying(64) NOT NULL,
    gwlist character varying(255) NOT NULL,
    description character varying(128) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.dr_rules OWNER TO pbxng;

--
-- Name: dr_rules_ruleid_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.dr_rules_ruleid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.dr_rules_ruleid_seq OWNER TO pbxng;

--
-- Name: dr_rules_ruleid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.dr_rules_ruleid_seq OWNED BY public.dr_rules.ruleid;


--
-- Name: extensions; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.extensions (
    id bigint NOT NULL,
    context character varying(40) NOT NULL,
    exten character varying(40) NOT NULL,
    priority integer NOT NULL,
    app character varying(40) NOT NULL,
    appdata character varying(256) NOT NULL
);


ALTER TABLE public.extensions OWNER TO pbxng;

--
-- Name: extensions_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.extensions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.extensions_id_seq OWNER TO pbxng;

--
-- Name: extensions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.extensions_id_seq OWNED BY public.extensions.id;


--
-- Name: iaxfriends; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.iaxfriends (
    id integer NOT NULL,
    name character varying(40) NOT NULL,
    type public.type_values,
    username character varying(40),
    mailbox character varying(40),
    secret character varying(40),
    dbsecret character varying(40),
    context character varying(40),
    regcontext character varying(40),
    host character varying(40),
    ipaddr character varying(40),
    port integer,
    defaultip character varying(20),
    sourceaddress character varying(20),
    mask character varying(20),
    regexten character varying(40),
    regseconds integer,
    accountcode character varying(80),
    mohinterpret character varying(20),
    mohsuggest character varying(20),
    inkeys character varying(40),
    outkeys character varying(40),
    language character varying(10),
    callerid character varying(100),
    cid_number character varying(40),
    sendani public.yes_no_values,
    fullname character varying(40),
    trunk public.yes_no_values,
    auth character varying(20),
    maxauthreq integer,
    requirecalltoken public.iax_requirecalltoken_values,
    encryption public.iax_encryption_values,
    transfer public.iax_transfer_values,
    jitterbuffer public.yes_no_values,
    forcejitterbuffer public.yes_no_values,
    disallow character varying(200),
    allow character varying(200),
    codecpriority character varying(40),
    qualify character varying(10),
    qualifysmoothing public.yes_no_values,
    qualifyfreqok character varying(10),
    qualifyfreqnotok character varying(10),
    timezone character varying(20),
    adsi public.yes_no_values,
    amaflags character varying(20),
    setvar character varying(200)
);


ALTER TABLE public.iaxfriends OWNER TO pbxng;

--
-- Name: iaxfriends_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.iaxfriends_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.iaxfriends_id_seq OWNER TO pbxng;

--
-- Name: iaxfriends_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.iaxfriends_id_seq OWNED BY public.iaxfriends.id;


--
-- Name: meetme; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.meetme (
    bookid integer NOT NULL,
    confno character varying(80) NOT NULL,
    starttime timestamp without time zone,
    endtime timestamp without time zone,
    pin character varying(20),
    adminpin character varying(20),
    opts character varying(20),
    adminopts character varying(20),
    recordingfilename character varying(80),
    recordingformat character varying(10),
    maxusers integer,
    members integer NOT NULL
);


ALTER TABLE public.meetme OWNER TO pbxng;

--
-- Name: meetme_bookid_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.meetme_bookid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.meetme_bookid_seq OWNER TO pbxng;

--
-- Name: meetme_bookid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.meetme_bookid_seq OWNED BY public.meetme.bookid;


--
-- Name: musiconhold; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.musiconhold (
    name character varying(80) NOT NULL,
    mode public.moh_mode_values,
    directory character varying(255),
    application character varying(255),
    digit character varying(1),
    sort character varying(10),
    format character varying(10),
    stamp timestamp without time zone,
    loop_last public.yesno_values
);


ALTER TABLE public.musiconhold OWNER TO pbxng;

--
-- Name: musiconhold_entry; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.musiconhold_entry (
    name character varying(80) NOT NULL,
    "position" integer NOT NULL,
    entry character varying(1024) NOT NULL
);


ALTER TABLE public.musiconhold_entry OWNER TO pbxng;

--
-- Name: pbxng_ai_agents; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ai_agents (
    id integer NOT NULL,
    name text,
    exten text,
    greeting text DEFAULT 'demo-congrats'::text,
    system_prompt text DEFAULT ''::text,
    voice text DEFAULT 'es-ES'::text,
    provider text DEFAULT 'openai'::text,
    model text DEFAULT 'gpt-4o-mini'::text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    sales_exten text,
    default_exten text,
    crm_webhook text,
    support_exten text,
    greeting_text text
);


ALTER TABLE public.pbxng_ai_agents OWNER TO pbxng;

--
-- Name: pbxng_ai_agents_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_ai_agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_ai_agents_id_seq OWNER TO pbxng;

--
-- Name: pbxng_ai_agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_ai_agents_id_seq OWNED BY public.pbxng_ai_agents.id;


--
-- Name: pbxng_c2c_sessions; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_c2c_sessions (
    id text NOT NULL,
    link_id integer,
    guest_ext text,
    dial_exten text,
    visitor_name text,
    geo text,
    meta text,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


ALTER TABLE public.pbxng_c2c_sessions OWNER TO pbxng;

--
-- Name: pbxng_call_geo; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_call_geo (
    id integer NOT NULL,
    ext text,
    number text,
    dir text,
    lat double precision,
    lng double precision,
    accuracy real,
    ua text,
    ts timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_call_geo OWNER TO pbxng;

--
-- Name: pbxng_call_geo_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_call_geo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_call_geo_id_seq OWNER TO pbxng;

--
-- Name: pbxng_call_geo_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_call_geo_id_seq OWNED BY public.pbxng_call_geo.id;


--
-- Name: pbxng_call_surveys; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_call_surveys (
    id integer NOT NULL,
    ext text,
    client_id integer,
    caller text,
    uniqueid text,
    answers jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_call_surveys OWNER TO pbxng;

--
-- Name: pbxng_call_surveys_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_call_surveys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_call_surveys_id_seq OWNER TO pbxng;

--
-- Name: pbxng_call_surveys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_call_surveys_id_seq OWNED BY public.pbxng_call_surveys.id;


--
-- Name: pbxng_captures; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_captures (
    id integer NOT NULL,
    node text,
    preset text,
    duration integer,
    status text DEFAULT 'pending'::text,
    filename text,
    size bigint DEFAULT 0,
    data bytea,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


ALTER TABLE public.pbxng_captures OWNER TO pbxng;

--
-- Name: pbxng_captures_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_captures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_captures_id_seq OWNER TO pbxng;

--
-- Name: pbxng_captures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_captures_id_seq OWNED BY public.pbxng_captures.id;


--
-- Name: pbxng_click2call; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_click2call (
    id integer NOT NULL,
    token text,
    name text,
    dest_type text DEFAULT 'extension'::text,
    dest_value text,
    intro text,
    require_name boolean DEFAULT true,
    collect_geo boolean DEFAULT false,
    video boolean DEFAULT false,
    enabled boolean DEFAULT true,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_click2call OWNER TO pbxng;

--
-- Name: pbxng_click2call_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_click2call_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_click2call_id_seq OWNER TO pbxng;

--
-- Name: pbxng_click2call_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_click2call_id_seq OWNED BY public.pbxng_click2call.id;


--
-- Name: pbxng_client_devices; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_client_devices (
    id integer NOT NULL,
    client_id integer,
    label text NOT NULL,
    type text DEFAULT 'camera'::text,
    rtsp_url text,
    go2rtc_src text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_client_devices OWNER TO pbxng;

--
-- Name: pbxng_client_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_client_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_client_devices_id_seq OWNER TO pbxng;

--
-- Name: pbxng_client_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_client_devices_id_seq OWNED BY public.pbxng_client_devices.id;


--
-- Name: pbxng_client_persons; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_client_persons (
    id integer NOT NULL,
    client_id integer,
    name text NOT NULL,
    doc text,
    relation text,
    valid_until date,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_client_persons OWNER TO pbxng;

--
-- Name: pbxng_client_persons_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_client_persons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_client_persons_id_seq OWNER TO pbxng;

--
-- Name: pbxng_client_persons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_client_persons_id_seq OWNED BY public.pbxng_client_persons.id;


--
-- Name: pbxng_client_spaces; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_client_spaces (
    id integer NOT NULL,
    client_id integer,
    name text NOT NULL,
    kind text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_client_spaces OWNER TO pbxng;

--
-- Name: pbxng_client_spaces_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_client_spaces_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_client_spaces_id_seq OWNER TO pbxng;

--
-- Name: pbxng_client_spaces_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_client_spaces_id_seq OWNED BY public.pbxng_client_spaces.id;


--
-- Name: pbxng_clients; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_clients (
    id integer NOT NULL,
    name text NOT NULL,
    doc text,
    address text,
    notes text,
    phones text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_clients OWNER TO pbxng;

--
-- Name: pbxng_clients_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_clients_id_seq OWNER TO pbxng;

--
-- Name: pbxng_clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_clients_id_seq OWNED BY public.pbxng_clients.id;


--
-- Name: pbxng_conferences; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_conferences (
    id integer NOT NULL,
    name text NOT NULL,
    label text,
    access_exten text NOT NULL,
    pin text,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_conferences OWNER TO pbxng;

--
-- Name: pbxng_conferences_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_conferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_conferences_id_seq OWNER TO pbxng;

--
-- Name: pbxng_conferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_conferences_id_seq OWNED BY public.pbxng_conferences.id;


--
-- Name: pbxng_directory; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_directory (
    ext text NOT NULL,
    name text,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_directory OWNER TO pbxng;

--
-- Name: pbxng_email_config; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_email_config (
    tenant_id integer NOT NULL,
    host text,
    port integer DEFAULT 587,
    secure boolean DEFAULT false,
    username text,
    password text,
    from_addr text,
    enabled boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_email_config OWNER TO pbxng;

--
-- Name: pbxng_enroll; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_enroll (
    token text NOT NULL,
    ext text,
    password text,
    label text,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    used_at timestamp with time zone
);


ALTER TABLE public.pbxng_enroll OWNER TO pbxng;

--
-- Name: pbxng_ep_backup; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ep_backup (
    id text NOT NULL,
    data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_ep_backup OWNER TO pbxng;

--
-- Name: pbxng_f2b_whitelist; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_f2b_whitelist (
    ip text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_f2b_whitelist OWNER TO pbxng;

--
-- Name: pbxng_fail2ban; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_fail2ban (
    jail text NOT NULL,
    banned jsonb DEFAULT '[]'::jsonb,
    total_failed integer DEFAULT 0,
    total_banned integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now(),
    bans jsonb DEFAULT '[]'::jsonb,
    config jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE public.pbxng_fail2ban OWNER TO pbxng;

--
-- Name: pbxng_fail2ban_cmd; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_fail2ban_cmd (
    id integer NOT NULL,
    cmd text,
    ip text,
    jail text,
    created_at timestamp with time zone DEFAULT now(),
    done_at timestamp with time zone
);


ALTER TABLE public.pbxng_fail2ban_cmd OWNER TO pbxng;

--
-- Name: pbxng_fail2ban_cmd_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_fail2ban_cmd_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_fail2ban_cmd_id_seq OWNER TO pbxng;

--
-- Name: pbxng_fail2ban_cmd_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_fail2ban_cmd_id_seq OWNED BY public.pbxng_fail2ban_cmd.id;


--
-- Name: pbxng_inbound_routes; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_inbound_routes (
    id integer NOT NULL,
    did text,
    name text,
    dest_type text,
    dest_value text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_inbound_routes OWNER TO pbxng;

--
-- Name: pbxng_inbound_routes_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_inbound_routes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_inbound_routes_id_seq OWNER TO pbxng;

--
-- Name: pbxng_inbound_routes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_inbound_routes_id_seq OWNED BY public.pbxng_inbound_routes.id;


--
-- Name: pbxng_integrations; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_integrations (
    type text NOT NULL,
    enabled boolean DEFAULT false,
    config jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_integrations OWNER TO pbxng;

--
-- Name: pbxng_ivr; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ivr (
    id integer NOT NULL,
    name text NOT NULL,
    exten text,
    greeting text DEFAULT 'demo-congrats'::text,
    timeout integer DEFAULT 10,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    flow jsonb
);


ALTER TABLE public.pbxng_ivr OWNER TO pbxng;

--
-- Name: pbxng_ivr_audios; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ivr_audios (
    id integer NOT NULL,
    name text,
    text text,
    voice text,
    ref text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_ivr_audios OWNER TO pbxng;

--
-- Name: pbxng_ivr_audios_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_ivr_audios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_ivr_audios_id_seq OWNER TO pbxng;

--
-- Name: pbxng_ivr_audios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_ivr_audios_id_seq OWNED BY public.pbxng_ivr_audios.id;


--
-- Name: pbxng_ivr_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_ivr_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_ivr_id_seq OWNER TO pbxng;

--
-- Name: pbxng_ivr_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_ivr_id_seq OWNED BY public.pbxng_ivr.id;


--
-- Name: pbxng_ivr_options; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ivr_options (
    id integer NOT NULL,
    ivr_id integer,
    digit text NOT NULL,
    dest_type text NOT NULL,
    dest_value text
);


ALTER TABLE public.pbxng_ivr_options OWNER TO pbxng;

--
-- Name: pbxng_ivr_options_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_ivr_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_ivr_options_id_seq OWNER TO pbxng;

--
-- Name: pbxng_ivr_options_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_ivr_options_id_seq OWNED BY public.pbxng_ivr_options.id;


--
-- Name: pbxng_mailboxes; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_mailboxes (
    mailbox text NOT NULL,
    fullname text,
    email text,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_mailboxes OWNER TO pbxng;

--
-- Name: pbxng_outbound_routes; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_outbound_routes (
    id integer NOT NULL,
    name text,
    pattern text,
    trunk text,
    strip integer DEFAULT 0,
    prepend text,
    callerid text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_outbound_routes OWNER TO pbxng;

--
-- Name: pbxng_outbound_routes_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_outbound_routes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_outbound_routes_id_seq OWNER TO pbxng;

--
-- Name: pbxng_outbound_routes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_outbound_routes_id_seq OWNED BY public.pbxng_outbound_routes.id;


--
-- Name: pbxng_paging; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_paging (
    id integer NOT NULL,
    name text NOT NULL,
    label text,
    access_exten text NOT NULL,
    members text NOT NULL,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_paging OWNER TO pbxng;

--
-- Name: pbxng_paging_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_paging_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_paging_id_seq OWNER TO pbxng;

--
-- Name: pbxng_paging_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_paging_id_seq OWNED BY public.pbxng_paging.id;


--
-- Name: pbxng_phones; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_phones (
    id integer NOT NULL,
    mac text,
    vendor text,
    model text,
    ext text,
    label text,
    line_label text,
    password text,
    tenant_id integer DEFAULT 1,
    last_seen timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_phones OWNER TO pbxng;

--
-- Name: pbxng_phones_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_phones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_phones_id_seq OWNER TO pbxng;

--
-- Name: pbxng_phones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_phones_id_seq OWNED BY public.pbxng_phones.id;


--
-- Name: pbxng_prompts; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_prompts (
    id integer NOT NULL,
    name text NOT NULL,
    format text DEFAULT 'wav'::text,
    bytes integer DEFAULT 0,
    data bytea,
    deleted boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    synced_at timestamp with time zone
);


ALTER TABLE public.pbxng_prompts OWNER TO pbxng;

--
-- Name: pbxng_prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_prompts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_prompts_id_seq OWNER TO pbxng;

--
-- Name: pbxng_prompts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_prompts_id_seq OWNED BY public.pbxng_prompts.id;


--
-- Name: pbxng_push_devices; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_push_devices (
    id integer NOT NULL,
    ext text,
    provider text,
    prid text,
    param text,
    topic text,
    ua text,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_push_devices OWNER TO pbxng;

--
-- Name: pbxng_push_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_push_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_push_devices_id_seq OWNER TO pbxng;

--
-- Name: pbxng_push_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_push_devices_id_seq OWNED BY public.pbxng_push_devices.id;


--
-- Name: pbxng_push_subs; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_push_subs (
    id integer NOT NULL,
    ext text NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    ua text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_push_subs OWNER TO pbxng;

--
-- Name: pbxng_push_subs_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_push_subs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_push_subs_id_seq OWNER TO pbxng;

--
-- Name: pbxng_push_subs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_push_subs_id_seq OWNED BY public.pbxng_push_subs.id;


--
-- Name: pbxng_queues; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_queues (
    name text NOT NULL,
    label text,
    access_exten text,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_queues OWNER TO pbxng;

--
-- Name: pbxng_rec_config; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_rec_config (
    id integer DEFAULT 1 NOT NULL,
    backend text DEFAULT 'local'::text,
    nas_path text,
    s3_endpoint text,
    s3_region text,
    s3_bucket text,
    s3_key text,
    s3_secret text,
    s3_prefix text DEFAULT 'recordings/'::text,
    auto_upload boolean DEFAULT false,
    retain_local boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_rec_config OWNER TO pbxng;

--
-- Name: pbxng_recordings; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_recordings (
    id integer NOT NULL,
    filename text NOT NULL,
    ext text,
    src text,
    dst text,
    started_at timestamp with time zone,
    bytes bigint DEFAULT 0,
    duration integer DEFAULT 0,
    storage text DEFAULT 'local'::text,
    remote_url text,
    linkedid text,
    deleted boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    transcript text,
    transcribed_at timestamp with time zone,
    analysis jsonb,
    peaks jsonb
);


ALTER TABLE public.pbxng_recordings OWNER TO pbxng;

--
-- Name: pbxng_recordings_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_recordings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_recordings_id_seq OWNER TO pbxng;

--
-- Name: pbxng_recordings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_recordings_id_seq OWNED BY public.pbxng_recordings.id;


--
-- Name: pbxng_ringgroups; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_ringgroups (
    id integer NOT NULL,
    name text NOT NULL,
    label text,
    access_exten text NOT NULL,
    members text NOT NULL,
    strategy text DEFAULT 'ringall'::text,
    ring_time integer DEFAULT 25,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_ringgroups OWNER TO pbxng;

--
-- Name: pbxng_ringgroups_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_ringgroups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_ringgroups_id_seq OWNER TO pbxng;

--
-- Name: pbxng_ringgroups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_ringgroups_id_seq OWNED BY public.pbxng_ringgroups.id;


--
-- Name: pbxng_sbc; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sbc (
    id integer DEFAULT 1 NOT NULL,
    uptime text,
    dispatcher jsonb DEFAULT '[]'::jsonb,
    banned jsonb DEFAULT '[]'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    rtpengine jsonb DEFAULT '{}'::jsonb,
    stats jsonb DEFAULT '{}'::jsonb,
    cfg_content text,
    version text
);


ALTER TABLE public.pbxng_sbc OWNER TO pbxng;

--
-- Name: pbxng_sbc_cmd; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sbc_cmd (
    id integer NOT NULL,
    cmd text NOT NULL,
    done boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    arg text,
    result text
);


ALTER TABLE public.pbxng_sbc_cmd OWNER TO pbxng;

--
-- Name: pbxng_sbc_cmd_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_sbc_cmd_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_sbc_cmd_id_seq OWNER TO pbxng;

--
-- Name: pbxng_sbc_cmd_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_sbc_cmd_id_seq OWNED BY public.pbxng_sbc_cmd.id;


--
-- Name: pbxng_sbc_routes; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sbc_routes (
    id integer NOT NULL,
    dest text,
    gw text,
    dev text,
    note text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_sbc_routes OWNER TO pbxng;

--
-- Name: pbxng_sbc_routes_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_sbc_routes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_sbc_routes_id_seq OWNER TO pbxng;

--
-- Name: pbxng_sbc_routes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_sbc_routes_id_seq OWNED BY public.pbxng_sbc_routes.id;


--
-- Name: pbxng_settings; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_settings (
    key text NOT NULL,
    value text
);


ALTER TABLE public.pbxng_settings OWNER TO pbxng;

--
-- Name: pbxng_sip_capture; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sip_capture (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now(),
    host text,
    src text,
    dst text,
    method text,
    status integer,
    callid text,
    cseq text,
    from_uri text,
    to_uri text,
    ruri text,
    raw text
);


ALTER TABLE public.pbxng_sip_capture OWNER TO pbxng;

--
-- Name: pbxng_sip_capture_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_sip_capture_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_sip_capture_id_seq OWNER TO pbxng;

--
-- Name: pbxng_sip_capture_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_sip_capture_id_seq OWNED BY public.pbxng_sip_capture.id;


--
-- Name: pbxng_sip_manip; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sip_manip (
    id integer NOT NULL,
    scope text DEFAULT 'all'::text NOT NULL,
    direction text DEFAULT 'out'::text NOT NULL,
    action text NOT NULL,
    header text,
    match text,
    value text,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_sip_manip OWNER TO pbxng;

--
-- Name: pbxng_sip_manip_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_sip_manip_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_sip_manip_id_seq OWNER TO pbxng;

--
-- Name: pbxng_sip_manip_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_sip_manip_id_seq OWNED BY public.pbxng_sip_manip.id;


--
-- Name: pbxng_survey_fields; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_survey_fields (
    id integer NOT NULL,
    ord integer DEFAULT 0,
    label text NOT NULL,
    ftype text DEFAULT 'text'::text,
    options jsonb DEFAULT '[]'::jsonb,
    required boolean DEFAULT false,
    active boolean DEFAULT true
);


ALTER TABLE public.pbxng_survey_fields OWNER TO pbxng;

--
-- Name: pbxng_survey_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_survey_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_survey_fields_id_seq OWNER TO pbxng;

--
-- Name: pbxng_survey_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_survey_fields_id_seq OWNED BY public.pbxng_survey_fields.id;


--
-- Name: pbxng_sysprompts; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_sysprompts (
    name text NOT NULL,
    category text,
    text text NOT NULL,
    voice text,
    audio bytea,
    fmt text DEFAULT 'wav'::text,
    status text DEFAULT 'pendiente'::text,
    revert boolean DEFAULT false,
    updated_at timestamp with time zone,
    deployed_at timestamp with time zone
);


ALTER TABLE public.pbxng_sysprompts OWNER TO pbxng;

--
-- Name: pbxng_trunks; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_trunks (
    id integer NOT NULL,
    name text NOT NULL,
    provider_host text NOT NULL,
    provider_port integer DEFAULT 5060,
    username text,
    do_register boolean DEFAULT true,
    tenant_id integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    kind text DEFAULT 'asterisk'::text,
    kam_config jsonb,
    adv_config jsonb
);


ALTER TABLE public.pbxng_trunks OWNER TO pbxng;

--
-- Name: pbxng_trunks_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_trunks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_trunks_id_seq OWNER TO pbxng;

--
-- Name: pbxng_trunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_trunks_id_seq OWNED BY public.pbxng_trunks.id;


--
-- Name: pbxng_users; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_users (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    name text,
    role text DEFAULT 'admin'::text,
    created_at timestamp with time zone DEFAULT now(),
    must_change boolean DEFAULT false,
    ext text
);


ALTER TABLE public.pbxng_users OWNER TO pbxng;

--
-- Name: pbxng_users_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.pbxng_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pbxng_users_id_seq OWNER TO pbxng;

--
-- Name: pbxng_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.pbxng_users_id_seq OWNED BY public.pbxng_users.id;


--
-- Name: pbxng_wsbridge_status; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.pbxng_wsbridge_status (
    name text NOT NULL,
    state text,
    detail text,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pbxng_wsbridge_status OWNER TO pbxng;

--
-- Name: ps_aors; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_aors (
    id character varying(255) NOT NULL,
    contact character varying(255),
    default_expiration integer,
    mailboxes character varying(80),
    max_contacts integer,
    minimum_expiration integer,
    remove_existing public.ast_bool_values,
    qualify_frequency integer,
    authenticate_qualify public.ast_bool_values,
    maximum_expiration integer,
    outbound_proxy character varying(255),
    support_path public.ast_bool_values,
    qualify_timeout double precision,
    voicemail_extension character varying(40),
    remove_unavailable public.ast_bool_values,
    qualify_2xx_only public.ast_bool_values,
    tenant_id integer DEFAULT 1
);


ALTER TABLE public.ps_aors OWNER TO pbxng;

--
-- Name: ps_asterisk_publications; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_asterisk_publications (
    id character varying(40) NOT NULL,
    devicestate_publish character varying(40),
    mailboxstate_publish character varying(40),
    device_state public.ast_bool_values,
    device_state_filter character varying(256),
    mailbox_state public.ast_bool_values,
    mailbox_state_filter character varying(256)
);


ALTER TABLE public.ps_asterisk_publications OWNER TO pbxng;

--
-- Name: ps_auths; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_auths (
    id character varying(255) NOT NULL,
    auth_type public.pjsip_auth_type_values_v2,
    nonce_lifetime integer,
    md5_cred character varying(40),
    password character varying(80),
    realm character varying(255),
    username character varying(40),
    refresh_token character varying(255),
    oauth_clientid character varying(255),
    oauth_secret character varying(255),
    password_digest character varying(1024),
    supported_algorithms_uas character varying(1024),
    supported_algorithms_uac character varying(1024),
    tenant_id integer DEFAULT 1
);


ALTER TABLE public.ps_auths OWNER TO pbxng;

--
-- Name: ps_contacts; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_contacts (
    id character varying(255) NOT NULL,
    uri character varying(511),
    expiration_time bigint,
    qualify_frequency integer,
    outbound_proxy character varying(255),
    path text,
    user_agent character varying(255),
    qualify_timeout double precision,
    reg_server character varying(255),
    authenticate_qualify public.ast_bool_values,
    via_addr character varying(40),
    via_port integer,
    call_id character varying(255),
    endpoint character varying(255),
    prune_on_boot public.ast_bool_values,
    qualify_2xx_only public.ast_bool_values
);


ALTER TABLE public.ps_contacts OWNER TO pbxng;

--
-- Name: ps_domain_aliases; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_domain_aliases (
    id character varying(255) NOT NULL,
    domain character varying(255)
);


ALTER TABLE public.ps_domain_aliases OWNER TO pbxng;

--
-- Name: ps_endpoint_id_ips; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_endpoint_id_ips (
    id character varying(255) NOT NULL,
    endpoint character varying(255),
    match character varying(80),
    srv_lookups public.ast_bool_values,
    match_header character varying(255),
    match_request_uri character varying(255)
);


ALTER TABLE public.ps_endpoint_id_ips OWNER TO pbxng;

--
-- Name: ps_endpoints; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_endpoints (
    id character varying(255) NOT NULL,
    transport character varying(40),
    aors character varying(2048),
    auth character varying(255),
    context character varying(40),
    disallow character varying(200),
    allow character varying(200),
    direct_media public.ast_bool_values,
    connected_line_method public.pjsip_connected_line_method_values,
    direct_media_method public.pjsip_connected_line_method_values,
    direct_media_glare_mitigation public.pjsip_direct_media_glare_mitigation_values,
    disable_direct_media_on_nat public.ast_bool_values,
    dtmf_mode public.pjsip_dtmf_mode_values_v3,
    external_media_address character varying(40),
    force_rport public.ast_bool_values,
    ice_support public.ast_bool_values,
    identify_by character varying(80) DEFAULT 'username,ip'::character varying,
    mailboxes character varying(40),
    moh_suggest character varying(40),
    outbound_auth character varying(255),
    outbound_proxy character varying(255),
    rewrite_contact public.ast_bool_values,
    rtp_ipv6 public.ast_bool_values,
    rtp_symmetric public.ast_bool_values,
    send_diversion public.ast_bool_values,
    send_pai public.ast_bool_values,
    send_rpid public.ast_bool_values,
    timers_min_se integer,
    timers public.pjsip_timer_values,
    timers_sess_expires integer,
    callerid character varying(40),
    callerid_privacy public.pjsip_cid_privacy_values,
    callerid_tag character varying(40),
    "100rel" public.pjsip_100rel_values_v2,
    aggregate_mwi public.ast_bool_values,
    trust_id_inbound public.ast_bool_values,
    trust_id_outbound public.ast_bool_values,
    use_ptime public.ast_bool_values,
    use_avpf public.ast_bool_values,
    media_encryption public.pjsip_media_encryption_values,
    inband_progress public.ast_bool_values,
    call_group character varying(40),
    pickup_group character varying(40),
    named_call_group character varying(40),
    named_pickup_group character varying(40),
    device_state_busy_at integer,
    fax_detect public.ast_bool_values,
    t38_udptl public.ast_bool_values,
    t38_udptl_ec public.pjsip_t38udptl_ec_values,
    t38_udptl_maxdatagram integer,
    t38_udptl_nat public.ast_bool_values,
    t38_udptl_ipv6 public.ast_bool_values,
    tone_zone character varying(40),
    language character varying(40),
    one_touch_recording public.ast_bool_values,
    record_on_feature character varying(40),
    record_off_feature character varying(40),
    rtp_engine character varying(40),
    allow_transfer public.ast_bool_values,
    allow_subscribe public.ast_bool_values,
    sdp_owner character varying(40),
    sdp_session character varying(40),
    tos_audio character varying(10),
    tos_video character varying(10),
    sub_min_expiry integer,
    from_domain character varying(40),
    from_user character varying(40),
    mwi_from_user character varying(40),
    dtls_verify character varying(40),
    dtls_rekey character varying(40),
    dtls_cert_file character varying(200),
    dtls_private_key character varying(200),
    dtls_cipher character varying(200),
    dtls_ca_file character varying(200),
    dtls_ca_path character varying(200),
    dtls_setup public.pjsip_dtls_setup_values,
    srtp_tag_32 public.ast_bool_values,
    media_address character varying(40),
    redirect_method public.pjsip_redirect_method_values,
    set_var text,
    cos_audio integer,
    cos_video integer,
    message_context character varying(40),
    force_avp public.ast_bool_values,
    media_use_received_transport public.ast_bool_values,
    accountcode character varying(80),
    user_eq_phone public.ast_bool_values,
    moh_passthrough public.ast_bool_values,
    media_encryption_optimistic public.ast_bool_values,
    rpid_immediate public.ast_bool_values,
    g726_non_standard public.ast_bool_values,
    rtp_keepalive integer,
    rtp_timeout integer,
    rtp_timeout_hold integer,
    bind_rtp_to_media_address public.ast_bool_values,
    voicemail_extension character varying(40),
    mwi_subscribe_replaces_unsolicited public.ast_bool_values,
    deny character varying(95),
    permit character varying(95),
    acl character varying(40),
    contact_deny character varying(95),
    contact_permit character varying(95),
    contact_acl character varying(40),
    subscribe_context character varying(40),
    fax_detect_timeout integer,
    contact_user character varying(80),
    preferred_codec_only public.ast_bool_values,
    asymmetric_rtp_codec public.ast_bool_values,
    rtcp_mux public.ast_bool_values,
    allow_overlap public.ast_bool_values,
    refer_blind_progress public.ast_bool_values,
    notify_early_inuse_ringing public.ast_bool_values,
    max_audio_streams integer,
    max_video_streams integer,
    webrtc public.ast_bool_values,
    dtls_fingerprint public.sha_hash_values,
    incoming_mwi_mailbox character varying(40),
    bundle public.ast_bool_values,
    dtls_auto_generate_cert public.ast_bool_values,
    follow_early_media_fork public.ast_bool_values,
    accept_multiple_sdp_answers public.ast_bool_values,
    suppress_q850_reason_headers public.ast_bool_values,
    trust_connected_line public.ast_bool_values,
    send_connected_line public.ast_bool_values,
    ignore_183_without_sdp public.ast_bool_values,
    codec_prefs_incoming_offer character varying(128),
    codec_prefs_outgoing_offer character varying(128),
    codec_prefs_incoming_answer character varying(128),
    codec_prefs_outgoing_answer character varying(128),
    stir_shaken public.ast_bool_values,
    send_history_info public.ast_bool_values,
    allow_unauthenticated_options public.ast_bool_values,
    t38_bind_udptl_to_media_address public.ast_bool_values,
    geoloc_incoming_call_profile character varying(80),
    geoloc_outgoing_call_profile character varying(80),
    incoming_call_offer_pref public.pjsip_incoming_call_offer_pref_values,
    outgoing_call_offer_pref public.pjsip_outgoing_call_offer_pref_values,
    stir_shaken_profile character varying(80),
    security_negotiation public.security_negotiation_values,
    security_mechanisms character varying(512),
    send_aoc public.ast_bool_values,
    overlap_context character varying(80),
    tenantid character varying(80),
    suppress_moh_on_sendonly public.ast_bool_values,
    follow_redirect_methods character varying(95),
    rtp_port_start integer,
    rtp_port_end integer,
    tenant_id integer DEFAULT 1,
    pbxng_kind character varying(20) DEFAULT 'extension'::character varying,
    pbxng_record boolean DEFAULT false
);


ALTER TABLE public.ps_endpoints OWNER TO pbxng;

--
-- Name: ps_globals; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_globals (
    id character varying(40) NOT NULL,
    max_forwards integer,
    user_agent character varying(255),
    default_outbound_endpoint character varying(40),
    debug character varying(40),
    endpoint_identifier_order character varying(40),
    max_initial_qualify_time integer,
    default_from_user character varying(80),
    keep_alive_interval integer,
    regcontext character varying(80),
    contact_expiration_check_interval integer,
    default_voicemail_extension character varying(40),
    disable_multi_domain public.ast_bool_values,
    unidentified_request_count integer,
    unidentified_request_period integer,
    unidentified_request_prune_interval integer,
    default_realm character varying(40),
    mwi_tps_queue_high integer,
    mwi_tps_queue_low integer,
    mwi_disable_initial_unsolicited public.ast_bool_values,
    ignore_uri_user_options public.ast_bool_values,
    use_callerid_contact public.ast_bool_values,
    send_contact_status_on_update_registration public.ast_bool_values,
    taskprocessor_overload_trigger public.pjsip_taskprocessor_overload_trigger_values,
    norefersub public.ast_bool_values,
    allow_sending_180_after_183 public.ast_bool_values,
    all_codecs_on_empty_reinvite public.ast_bool_values,
    default_auth_algorithms_uas character varying(1024),
    default_auth_algorithms_uac character varying(1024)
);


ALTER TABLE public.ps_globals OWNER TO pbxng;

--
-- Name: ps_inbound_publications; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_inbound_publications (
    id character varying(255) NOT NULL,
    endpoint character varying(255),
    "event_asterisk-devicestate" character varying(40),
    "event_asterisk-mwi" character varying(40)
);


ALTER TABLE public.ps_inbound_publications OWNER TO pbxng;

--
-- Name: ps_outbound_publishes; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_outbound_publishes (
    id character varying(255) NOT NULL,
    expiration integer,
    outbound_auth character varying(255),
    outbound_proxy character varying(256),
    server_uri character varying(256),
    from_uri character varying(256),
    to_uri character varying(256),
    event character varying(40),
    max_auth_attempts integer,
    transport character varying(40),
    multi_user public.ast_bool_values,
    "@body" character varying(40),
    "@context" character varying(256),
    "@exten" character varying(256)
);


ALTER TABLE public.ps_outbound_publishes OWNER TO pbxng;

--
-- Name: ps_registrations; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_registrations (
    id character varying(255) NOT NULL,
    auth_rejection_permanent public.ast_bool_values,
    client_uri character varying(255),
    contact_user character varying(40),
    expiration integer,
    max_retries integer,
    outbound_auth character varying(255),
    outbound_proxy character varying(255),
    retry_interval integer,
    forbidden_retry_interval integer,
    server_uri character varying(255),
    transport character varying(40),
    support_path public.ast_bool_values,
    fatal_retry_interval integer,
    line public.ast_bool_values,
    endpoint character varying(255),
    support_outbound public.ast_bool_values,
    contact_header_params character varying(255),
    max_random_initial_delay integer,
    security_negotiation public.security_negotiation_values,
    security_mechanisms character varying(512),
    user_agent character varying(255)
);


ALTER TABLE public.ps_registrations OWNER TO pbxng;

--
-- Name: ps_resource_list; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_resource_list (
    id character varying(40) NOT NULL,
    list_item character varying(2048),
    event character varying(40),
    full_state public.ast_bool_values,
    notification_batch_interval integer,
    resource_display_name public.ast_bool_values
);


ALTER TABLE public.ps_resource_list OWNER TO pbxng;

--
-- Name: ps_subscription_persistence; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_subscription_persistence (
    id character varying(40) NOT NULL,
    packet character varying(2048),
    src_name character varying(128),
    src_port integer,
    transport_key character varying(64),
    local_name character varying(128),
    local_port integer,
    cseq integer,
    tag character varying(128),
    endpoint character varying(40),
    expires integer,
    contact_uri character varying(256),
    prune_on_boot public.ast_bool_values,
    generator_data text
);


ALTER TABLE public.ps_subscription_persistence OWNER TO pbxng;

--
-- Name: ps_systems; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_systems (
    id character varying(40) NOT NULL,
    timer_t1 integer,
    timer_b integer,
    compact_headers public.ast_bool_values,
    threadpool_initial_size integer,
    threadpool_auto_increment integer,
    threadpool_idle_timeout integer,
    threadpool_max_size integer,
    disable_tcp_switch public.ast_bool_values,
    follow_early_media_fork public.ast_bool_values,
    accept_multiple_sdp_answers public.ast_bool_values,
    disable_rport public.ast_bool_values,
    taskpool_minimum_size integer,
    taskpool_initial_size integer,
    taskpool_auto_increment integer,
    taskpool_idle_timeout integer,
    taskpool_max_size integer
);


ALTER TABLE public.ps_systems OWNER TO pbxng;

--
-- Name: ps_transports; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.ps_transports (
    id character varying(40) NOT NULL,
    async_operations integer,
    bind character varying(40),
    ca_list_file character varying(200),
    cert_file character varying(200),
    cipher character varying(200),
    domain character varying(40),
    external_media_address character varying(40),
    external_signaling_address character varying(40),
    external_signaling_port integer,
    method public.pjsip_transport_method_values_v2,
    local_net character varying(40),
    password character varying(40),
    priv_key_file character varying(200),
    protocol public.pjsip_transport_protocol_values_v2,
    require_client_cert public.ast_bool_values,
    verify_client public.ast_bool_values,
    verify_server public.ast_bool_values,
    tos character varying(10),
    cos integer,
    allow_reload public.ast_bool_values,
    symmetric_transport public.ast_bool_values,
    allow_wildcard_certs public.ast_bool_values,
    tcp_keepalive_enable boolean,
    tcp_keepalive_idle_time integer,
    tcp_keepalive_interval_time integer,
    tcp_keepalive_probe_count integer
);


ALTER TABLE public.ps_transports OWNER TO pbxng;

--
-- Name: queue_members; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.queue_members (
    queue_name character varying(80) NOT NULL,
    interface character varying(80) NOT NULL,
    membername character varying(80),
    state_interface character varying(80),
    penalty integer,
    paused integer,
    uniqueid integer NOT NULL,
    wrapuptime integer,
    ringinuse public.ast_bool_values,
    reason_paused character varying(80)
);


ALTER TABLE public.queue_members OWNER TO pbxng;

--
-- Name: queue_rules; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.queue_rules (
    rule_name character varying(80) NOT NULL,
    "time" character varying(32) NOT NULL,
    min_penalty character varying(32) NOT NULL,
    max_penalty character varying(32) NOT NULL
);


ALTER TABLE public.queue_rules OWNER TO pbxng;

--
-- Name: queues; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.queues (
    name character varying(128) NOT NULL,
    musiconhold character varying(128),
    announce character varying(128),
    context character varying(128),
    timeout integer,
    ringinuse public.yesno_values,
    setinterfacevar public.yesno_values,
    setqueuevar public.yesno_values,
    setqueueentryvar public.yesno_values,
    monitor_format character varying(8),
    membermacro character varying(512),
    membergosub character varying(512),
    queue_youarenext character varying(128),
    queue_thereare character varying(128),
    queue_callswaiting character varying(128),
    queue_quantity1 character varying(128),
    queue_quantity2 character varying(128),
    queue_holdtime character varying(128),
    queue_minutes character varying(128),
    queue_minute character varying(128),
    queue_seconds character varying(128),
    queue_thankyou character varying(128),
    queue_callerannounce character varying(128),
    queue_reporthold character varying(128),
    announce_frequency integer,
    announce_to_first_user public.yesno_values,
    min_announce_frequency integer,
    announce_round_seconds integer,
    announce_holdtime character varying(128),
    announce_position character varying(128),
    announce_position_limit integer,
    periodic_announce character varying(50),
    periodic_announce_frequency integer,
    relative_periodic_announce public.yesno_values,
    random_periodic_announce public.yesno_values,
    retry integer,
    wrapuptime integer,
    penaltymemberslimit integer,
    autofill public.yesno_values,
    monitor_type character varying(128),
    autopause public.queue_autopause_values,
    autopausedelay integer,
    autopausebusy public.yesno_values,
    autopauseunavail public.yesno_values,
    maxlen integer,
    servicelevel integer,
    strategy public.queue_strategy_values,
    joinempty character varying(128),
    leavewhenempty character varying(128),
    reportholdtime public.yesno_values,
    memberdelay integer,
    weight integer,
    timeoutrestart public.yesno_values,
    defaultrule character varying(128),
    timeoutpriority character varying(128),
    log_restricted_caller_id public.ast_bool_values
);


ALTER TABLE public.queues OWNER TO pbxng;

--
-- Name: secfilter; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.secfilter (
    id integer NOT NULL,
    action integer DEFAULT 0 NOT NULL,
    type integer DEFAULT 0 NOT NULL,
    data character varying(128) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.secfilter OWNER TO pbxng;

--
-- Name: secfilter_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.secfilter_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.secfilter_id_seq OWNER TO pbxng;

--
-- Name: secfilter_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.secfilter_id_seq OWNED BY public.secfilter.id;


--
-- Name: sippeers; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.sippeers (
    id integer NOT NULL,
    name character varying(40) NOT NULL,
    ipaddr character varying(45),
    port integer,
    regseconds integer,
    defaultuser character varying(40),
    fullcontact character varying(80),
    regserver character varying(20),
    useragent character varying(255),
    lastms integer,
    host character varying(40),
    type public.type_values,
    context character varying(40),
    permit character varying(95),
    deny character varying(95),
    secret character varying(40),
    md5secret character varying(40),
    remotesecret character varying(40),
    transport public.sip_transport_values,
    dtmfmode public.sip_dtmfmode_values,
    directmedia public.sip_directmedia_values_v2,
    nat character varying(29),
    callgroup character varying(40),
    pickupgroup character varying(40),
    language character varying(40),
    disallow character varying(200),
    allow character varying(200),
    insecure character varying(40),
    trustrpid public.yes_no_values,
    progressinband public.sip_progressinband_values,
    promiscredir public.yes_no_values,
    useclientcode public.yes_no_values,
    accountcode character varying(80),
    setvar character varying(200),
    callerid character varying(40),
    amaflags character varying(40),
    callcounter public.yes_no_values,
    busylevel integer,
    allowoverlap public.yes_no_values,
    allowsubscribe public.yes_no_values,
    videosupport public.yes_no_values,
    maxcallbitrate integer,
    rfc2833compensate public.yes_no_values,
    mailbox character varying(40),
    "session-timers" public.sip_session_timers_values,
    "session-expires" integer,
    "session-minse" integer,
    "session-refresher" public.sip_session_refresher_values,
    t38pt_usertpsource character varying(40),
    regexten character varying(40),
    fromdomain character varying(40),
    fromuser character varying(40),
    qualify character varying(40),
    defaultip character varying(45),
    rtptimeout integer,
    rtpholdtimeout integer,
    sendrpid public.yes_no_values,
    outboundproxy character varying(40),
    callbackextension character varying(40),
    timert1 integer,
    timerb integer,
    qualifyfreq integer,
    constantssrc public.yes_no_values,
    contactpermit character varying(95),
    contactdeny character varying(95),
    usereqphone public.yes_no_values,
    textsupport public.yes_no_values,
    faxdetect public.yes_no_values,
    buggymwi public.yes_no_values,
    auth character varying(40),
    fullname character varying(40),
    trunkname character varying(40),
    cid_number character varying(40),
    callingpres public.sip_callingpres_values,
    mohinterpret character varying(40),
    mohsuggest character varying(40),
    parkinglot character varying(40),
    hasvoicemail public.yes_no_values,
    subscribemwi public.yes_no_values,
    vmexten character varying(40),
    autoframing public.yes_no_values,
    rtpkeepalive integer,
    "call-limit" integer,
    g726nonstandard public.yes_no_values,
    ignoresdpversion public.yes_no_values,
    allowtransfer public.yes_no_values,
    dynamic public.yes_no_values,
    path character varying(256),
    supportpath public.yes_no_values
);


ALTER TABLE public.sippeers OWNER TO pbxng;

--
-- Name: sippeers_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.sippeers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.sippeers_id_seq OWNER TO pbxng;

--
-- Name: sippeers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.sippeers_id_seq OWNED BY public.sippeers.id;


--
-- Name: stir_tn; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.stir_tn (
    id character varying(80) NOT NULL,
    private_key_file character varying(1024),
    public_cert_url character varying(1024),
    attest_level character varying(1),
    send_mky public.ast_bool_values
);


ALTER TABLE public.stir_tn OWNER TO pbxng;

--
-- Name: tenants; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.tenants (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    context_prefix text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.tenants OWNER TO pbxng;

--
-- Name: tenants_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.tenants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tenants_id_seq OWNER TO pbxng;

--
-- Name: tenants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.tenants_id_seq OWNED BY public.tenants.id;


--
-- Name: uacreg; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.uacreg (
    id integer NOT NULL,
    l_uuid character varying(64) DEFAULT ''::character varying NOT NULL,
    l_username character varying(64) DEFAULT ''::character varying NOT NULL,
    l_domain character varying(190) DEFAULT ''::character varying NOT NULL,
    r_username character varying(64) DEFAULT ''::character varying NOT NULL,
    r_domain character varying(190) DEFAULT ''::character varying NOT NULL,
    realm character varying(64) DEFAULT ''::character varying NOT NULL,
    auth_username character varying(64) DEFAULT ''::character varying NOT NULL,
    auth_password character varying(64) DEFAULT ''::character varying NOT NULL,
    auth_ha1 character varying(128) DEFAULT ''::character varying NOT NULL,
    auth_proxy character varying(255) DEFAULT ''::character varying NOT NULL,
    expires integer DEFAULT 0 NOT NULL,
    flags integer DEFAULT 0 NOT NULL,
    reg_delay integer DEFAULT 0 NOT NULL,
    socket character varying(128) DEFAULT ''::character varying NOT NULL,
    contact_addr character varying(255) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE public.uacreg OWNER TO pbxng;

--
-- Name: uacreg_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.uacreg_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.uacreg_id_seq OWNER TO pbxng;

--
-- Name: uacreg_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.uacreg_id_seq OWNED BY public.uacreg.id;


--
-- Name: version; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.version (
    id integer NOT NULL,
    table_name character varying(32) NOT NULL,
    table_version integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.version OWNER TO pbxng;

--
-- Name: version_id_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.version_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.version_id_seq OWNER TO pbxng;

--
-- Name: version_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.version_id_seq OWNED BY public.version.id;


--
-- Name: voicemail; Type: TABLE; Schema: public; Owner: pbxng
--

CREATE TABLE public.voicemail (
    uniqueid integer NOT NULL,
    context character varying(80) NOT NULL,
    mailbox character varying(80) NOT NULL,
    password character varying(80) NOT NULL,
    fullname character varying(80),
    alias character varying(80),
    email character varying(80),
    pager character varying(80),
    attach public.yes_no_values,
    attachfmt character varying(10),
    serveremail character varying(80),
    language character varying(20),
    tz character varying(30),
    deletevoicemail public.yes_no_values,
    saycid public.yes_no_values,
    sendvoicemail public.yes_no_values,
    review public.yes_no_values,
    tempgreetwarn public.yes_no_values,
    operator public.yes_no_values,
    envelope public.yes_no_values,
    sayduration integer,
    forcename public.yes_no_values,
    forcegreetings public.yes_no_values,
    callback character varying(80),
    dialout character varying(80),
    exitcontext character varying(80),
    maxmsg integer,
    volgain numeric(5,2),
    imapuser character varying(80),
    imappassword character varying(80),
    imapserver character varying(80),
    imapport character varying(8),
    imapflags character varying(80),
    stamp timestamp without time zone
);


ALTER TABLE public.voicemail OWNER TO pbxng;

--
-- Name: voicemail_uniqueid_seq; Type: SEQUENCE; Schema: public; Owner: pbxng
--

CREATE SEQUENCE public.voicemail_uniqueid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.voicemail_uniqueid_seq OWNER TO pbxng;

--
-- Name: voicemail_uniqueid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: pbxng
--

ALTER SEQUENCE public.voicemail_uniqueid_seq OWNED BY public.voicemail.uniqueid;


--
-- Name: dr_gateways gwid; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_gateways ALTER COLUMN gwid SET DEFAULT nextval('public.dr_gateways_gwid_seq'::regclass);


--
-- Name: dr_groups id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_groups ALTER COLUMN id SET DEFAULT nextval('public.dr_groups_id_seq'::regclass);


--
-- Name: dr_gw_lists id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_gw_lists ALTER COLUMN id SET DEFAULT nextval('public.dr_gw_lists_id_seq'::regclass);


--
-- Name: dr_rules ruleid; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_rules ALTER COLUMN ruleid SET DEFAULT nextval('public.dr_rules_ruleid_seq'::regclass);


--
-- Name: extensions id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.extensions ALTER COLUMN id SET DEFAULT nextval('public.extensions_id_seq'::regclass);


--
-- Name: iaxfriends id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.iaxfriends ALTER COLUMN id SET DEFAULT nextval('public.iaxfriends_id_seq'::regclass);


--
-- Name: meetme bookid; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.meetme ALTER COLUMN bookid SET DEFAULT nextval('public.meetme_bookid_seq'::regclass);


--
-- Name: pbxng_ai_agents id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ai_agents ALTER COLUMN id SET DEFAULT nextval('public.pbxng_ai_agents_id_seq'::regclass);


--
-- Name: pbxng_call_geo id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_call_geo ALTER COLUMN id SET DEFAULT nextval('public.pbxng_call_geo_id_seq'::regclass);


--
-- Name: pbxng_call_surveys id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_call_surveys ALTER COLUMN id SET DEFAULT nextval('public.pbxng_call_surveys_id_seq'::regclass);


--
-- Name: pbxng_captures id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_captures ALTER COLUMN id SET DEFAULT nextval('public.pbxng_captures_id_seq'::regclass);


--
-- Name: pbxng_click2call id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_click2call ALTER COLUMN id SET DEFAULT nextval('public.pbxng_click2call_id_seq'::regclass);


--
-- Name: pbxng_client_devices id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_devices ALTER COLUMN id SET DEFAULT nextval('public.pbxng_client_devices_id_seq'::regclass);


--
-- Name: pbxng_client_persons id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_persons ALTER COLUMN id SET DEFAULT nextval('public.pbxng_client_persons_id_seq'::regclass);


--
-- Name: pbxng_client_spaces id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_spaces ALTER COLUMN id SET DEFAULT nextval('public.pbxng_client_spaces_id_seq'::regclass);


--
-- Name: pbxng_clients id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_clients ALTER COLUMN id SET DEFAULT nextval('public.pbxng_clients_id_seq'::regclass);


--
-- Name: pbxng_conferences id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_conferences ALTER COLUMN id SET DEFAULT nextval('public.pbxng_conferences_id_seq'::regclass);


--
-- Name: pbxng_fail2ban_cmd id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_fail2ban_cmd ALTER COLUMN id SET DEFAULT nextval('public.pbxng_fail2ban_cmd_id_seq'::regclass);


--
-- Name: pbxng_inbound_routes id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_inbound_routes ALTER COLUMN id SET DEFAULT nextval('public.pbxng_inbound_routes_id_seq'::regclass);


--
-- Name: pbxng_ivr id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr ALTER COLUMN id SET DEFAULT nextval('public.pbxng_ivr_id_seq'::regclass);


--
-- Name: pbxng_ivr_audios id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_audios ALTER COLUMN id SET DEFAULT nextval('public.pbxng_ivr_audios_id_seq'::regclass);


--
-- Name: pbxng_ivr_options id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_options ALTER COLUMN id SET DEFAULT nextval('public.pbxng_ivr_options_id_seq'::regclass);


--
-- Name: pbxng_outbound_routes id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_outbound_routes ALTER COLUMN id SET DEFAULT nextval('public.pbxng_outbound_routes_id_seq'::regclass);


--
-- Name: pbxng_paging id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_paging ALTER COLUMN id SET DEFAULT nextval('public.pbxng_paging_id_seq'::regclass);


--
-- Name: pbxng_phones id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_phones ALTER COLUMN id SET DEFAULT nextval('public.pbxng_phones_id_seq'::regclass);


--
-- Name: pbxng_prompts id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_prompts ALTER COLUMN id SET DEFAULT nextval('public.pbxng_prompts_id_seq'::regclass);


--
-- Name: pbxng_push_devices id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_devices ALTER COLUMN id SET DEFAULT nextval('public.pbxng_push_devices_id_seq'::regclass);


--
-- Name: pbxng_push_subs id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_subs ALTER COLUMN id SET DEFAULT nextval('public.pbxng_push_subs_id_seq'::regclass);


--
-- Name: pbxng_recordings id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_recordings ALTER COLUMN id SET DEFAULT nextval('public.pbxng_recordings_id_seq'::regclass);


--
-- Name: pbxng_ringgroups id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ringgroups ALTER COLUMN id SET DEFAULT nextval('public.pbxng_ringgroups_id_seq'::regclass);


--
-- Name: pbxng_sbc_cmd id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sbc_cmd ALTER COLUMN id SET DEFAULT nextval('public.pbxng_sbc_cmd_id_seq'::regclass);


--
-- Name: pbxng_sbc_routes id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sbc_routes ALTER COLUMN id SET DEFAULT nextval('public.pbxng_sbc_routes_id_seq'::regclass);


--
-- Name: pbxng_sip_capture id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sip_capture ALTER COLUMN id SET DEFAULT nextval('public.pbxng_sip_capture_id_seq'::regclass);


--
-- Name: pbxng_sip_manip id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sip_manip ALTER COLUMN id SET DEFAULT nextval('public.pbxng_sip_manip_id_seq'::regclass);


--
-- Name: pbxng_survey_fields id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_survey_fields ALTER COLUMN id SET DEFAULT nextval('public.pbxng_survey_fields_id_seq'::regclass);


--
-- Name: pbxng_trunks id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_trunks ALTER COLUMN id SET DEFAULT nextval('public.pbxng_trunks_id_seq'::regclass);


--
-- Name: pbxng_users id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_users ALTER COLUMN id SET DEFAULT nextval('public.pbxng_users_id_seq'::regclass);


--
-- Name: secfilter id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.secfilter ALTER COLUMN id SET DEFAULT nextval('public.secfilter_id_seq'::regclass);


--
-- Name: sippeers id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.sippeers ALTER COLUMN id SET DEFAULT nextval('public.sippeers_id_seq'::regclass);


--
-- Name: tenants id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.tenants ALTER COLUMN id SET DEFAULT nextval('public.tenants_id_seq'::regclass);


--
-- Name: uacreg id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.uacreg ALTER COLUMN id SET DEFAULT nextval('public.uacreg_id_seq'::regclass);


--
-- Name: version id; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.version ALTER COLUMN id SET DEFAULT nextval('public.version_id_seq'::regclass);


--
-- Name: voicemail uniqueid; Type: DEFAULT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.voicemail ALTER COLUMN uniqueid SET DEFAULT nextval('public.voicemail_uniqueid_seq'::regclass);


--
-- Name: alembic_version_cdr alembic_version_cdr_pkc; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.alembic_version_cdr
    ADD CONSTRAINT alembic_version_cdr_pkc PRIMARY KEY (version_num);


--
-- Name: alembic_version_config alembic_version_config_pkc; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.alembic_version_config
    ADD CONSTRAINT alembic_version_config_pkc PRIMARY KEY (version_num);


--
-- Name: dr_gateways dr_gateways_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_gateways
    ADD CONSTRAINT dr_gateways_pkey PRIMARY KEY (gwid);


--
-- Name: dr_groups dr_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_groups
    ADD CONSTRAINT dr_groups_pkey PRIMARY KEY (id);


--
-- Name: dr_gw_lists dr_gw_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_gw_lists
    ADD CONSTRAINT dr_gw_lists_pkey PRIMARY KEY (id);


--
-- Name: dr_rules dr_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.dr_rules
    ADD CONSTRAINT dr_rules_pkey PRIMARY KEY (ruleid);


--
-- Name: extensions extensions_context_exten_priority_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.extensions
    ADD CONSTRAINT extensions_context_exten_priority_key UNIQUE (context, exten, priority);


--
-- Name: extensions extensions_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.extensions
    ADD CONSTRAINT extensions_pkey PRIMARY KEY (id);


--
-- Name: iaxfriends iaxfriends_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.iaxfriends
    ADD CONSTRAINT iaxfriends_name_key UNIQUE (name);


--
-- Name: iaxfriends iaxfriends_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.iaxfriends
    ADD CONSTRAINT iaxfriends_pkey PRIMARY KEY (id);


--
-- Name: meetme meetme_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.meetme
    ADD CONSTRAINT meetme_pkey PRIMARY KEY (bookid);


--
-- Name: musiconhold_entry musiconhold_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.musiconhold_entry
    ADD CONSTRAINT musiconhold_entry_pkey PRIMARY KEY (name, "position");


--
-- Name: musiconhold musiconhold_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.musiconhold
    ADD CONSTRAINT musiconhold_pkey PRIMARY KEY (name);


--
-- Name: pbxng_ai_agents pbxng_ai_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ai_agents
    ADD CONSTRAINT pbxng_ai_agents_pkey PRIMARY KEY (id);


--
-- Name: pbxng_c2c_sessions pbxng_c2c_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_c2c_sessions
    ADD CONSTRAINT pbxng_c2c_sessions_pkey PRIMARY KEY (id);


--
-- Name: pbxng_call_geo pbxng_call_geo_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_call_geo
    ADD CONSTRAINT pbxng_call_geo_pkey PRIMARY KEY (id);


--
-- Name: pbxng_call_surveys pbxng_call_surveys_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_call_surveys
    ADD CONSTRAINT pbxng_call_surveys_pkey PRIMARY KEY (id);


--
-- Name: pbxng_captures pbxng_captures_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_captures
    ADD CONSTRAINT pbxng_captures_pkey PRIMARY KEY (id);


--
-- Name: pbxng_click2call pbxng_click2call_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_click2call
    ADD CONSTRAINT pbxng_click2call_pkey PRIMARY KEY (id);


--
-- Name: pbxng_click2call pbxng_click2call_token_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_click2call
    ADD CONSTRAINT pbxng_click2call_token_key UNIQUE (token);


--
-- Name: pbxng_client_devices pbxng_client_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_devices
    ADD CONSTRAINT pbxng_client_devices_pkey PRIMARY KEY (id);


--
-- Name: pbxng_client_persons pbxng_client_persons_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_persons
    ADD CONSTRAINT pbxng_client_persons_pkey PRIMARY KEY (id);


--
-- Name: pbxng_client_spaces pbxng_client_spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_spaces
    ADD CONSTRAINT pbxng_client_spaces_pkey PRIMARY KEY (id);


--
-- Name: pbxng_clients pbxng_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_clients
    ADD CONSTRAINT pbxng_clients_pkey PRIMARY KEY (id);


--
-- Name: pbxng_conferences pbxng_conferences_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_conferences
    ADD CONSTRAINT pbxng_conferences_name_key UNIQUE (name);


--
-- Name: pbxng_conferences pbxng_conferences_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_conferences
    ADD CONSTRAINT pbxng_conferences_pkey PRIMARY KEY (id);


--
-- Name: pbxng_directory pbxng_directory_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_directory
    ADD CONSTRAINT pbxng_directory_pkey PRIMARY KEY (ext);


--
-- Name: pbxng_email_config pbxng_email_config_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_email_config
    ADD CONSTRAINT pbxng_email_config_pkey PRIMARY KEY (tenant_id);


--
-- Name: pbxng_enroll pbxng_enroll_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_enroll
    ADD CONSTRAINT pbxng_enroll_pkey PRIMARY KEY (token);


--
-- Name: pbxng_ep_backup pbxng_ep_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ep_backup
    ADD CONSTRAINT pbxng_ep_backup_pkey PRIMARY KEY (id);


--
-- Name: pbxng_f2b_whitelist pbxng_f2b_whitelist_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_f2b_whitelist
    ADD CONSTRAINT pbxng_f2b_whitelist_pkey PRIMARY KEY (ip);


--
-- Name: pbxng_fail2ban_cmd pbxng_fail2ban_cmd_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_fail2ban_cmd
    ADD CONSTRAINT pbxng_fail2ban_cmd_pkey PRIMARY KEY (id);


--
-- Name: pbxng_fail2ban pbxng_fail2ban_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_fail2ban
    ADD CONSTRAINT pbxng_fail2ban_pkey PRIMARY KEY (jail);


--
-- Name: pbxng_inbound_routes pbxng_inbound_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_inbound_routes
    ADD CONSTRAINT pbxng_inbound_routes_pkey PRIMARY KEY (id);


--
-- Name: pbxng_integrations pbxng_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_integrations
    ADD CONSTRAINT pbxng_integrations_pkey PRIMARY KEY (type);


--
-- Name: pbxng_ivr_audios pbxng_ivr_audios_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_audios
    ADD CONSTRAINT pbxng_ivr_audios_name_key UNIQUE (name);


--
-- Name: pbxng_ivr_audios pbxng_ivr_audios_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_audios
    ADD CONSTRAINT pbxng_ivr_audios_pkey PRIMARY KEY (id);


--
-- Name: pbxng_ivr_options pbxng_ivr_options_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_options
    ADD CONSTRAINT pbxng_ivr_options_pkey PRIMARY KEY (id);


--
-- Name: pbxng_ivr pbxng_ivr_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr
    ADD CONSTRAINT pbxng_ivr_pkey PRIMARY KEY (id);


--
-- Name: pbxng_mailboxes pbxng_mailboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_mailboxes
    ADD CONSTRAINT pbxng_mailboxes_pkey PRIMARY KEY (mailbox);


--
-- Name: pbxng_outbound_routes pbxng_outbound_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_outbound_routes
    ADD CONSTRAINT pbxng_outbound_routes_pkey PRIMARY KEY (id);


--
-- Name: pbxng_paging pbxng_paging_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_paging
    ADD CONSTRAINT pbxng_paging_name_key UNIQUE (name);


--
-- Name: pbxng_paging pbxng_paging_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_paging
    ADD CONSTRAINT pbxng_paging_pkey PRIMARY KEY (id);


--
-- Name: pbxng_phones pbxng_phones_mac_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_phones
    ADD CONSTRAINT pbxng_phones_mac_key UNIQUE (mac);


--
-- Name: pbxng_phones pbxng_phones_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_phones
    ADD CONSTRAINT pbxng_phones_pkey PRIMARY KEY (id);


--
-- Name: pbxng_prompts pbxng_prompts_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_prompts
    ADD CONSTRAINT pbxng_prompts_name_key UNIQUE (name);


--
-- Name: pbxng_prompts pbxng_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_prompts
    ADD CONSTRAINT pbxng_prompts_pkey PRIMARY KEY (id);


--
-- Name: pbxng_push_devices pbxng_push_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_devices
    ADD CONSTRAINT pbxng_push_devices_pkey PRIMARY KEY (id);


--
-- Name: pbxng_push_devices pbxng_push_devices_provider_prid_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_devices
    ADD CONSTRAINT pbxng_push_devices_provider_prid_key UNIQUE (provider, prid);


--
-- Name: pbxng_push_subs pbxng_push_subs_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_subs
    ADD CONSTRAINT pbxng_push_subs_endpoint_key UNIQUE (endpoint);


--
-- Name: pbxng_push_subs pbxng_push_subs_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_push_subs
    ADD CONSTRAINT pbxng_push_subs_pkey PRIMARY KEY (id);


--
-- Name: pbxng_queues pbxng_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_queues
    ADD CONSTRAINT pbxng_queues_pkey PRIMARY KEY (name);


--
-- Name: pbxng_rec_config pbxng_rec_config_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_rec_config
    ADD CONSTRAINT pbxng_rec_config_pkey PRIMARY KEY (id);


--
-- Name: pbxng_recordings pbxng_recordings_filename_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_recordings
    ADD CONSTRAINT pbxng_recordings_filename_key UNIQUE (filename);


--
-- Name: pbxng_recordings pbxng_recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_recordings
    ADD CONSTRAINT pbxng_recordings_pkey PRIMARY KEY (id);


--
-- Name: pbxng_ringgroups pbxng_ringgroups_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ringgroups
    ADD CONSTRAINT pbxng_ringgroups_name_key UNIQUE (name);


--
-- Name: pbxng_ringgroups pbxng_ringgroups_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ringgroups
    ADD CONSTRAINT pbxng_ringgroups_pkey PRIMARY KEY (id);


--
-- Name: pbxng_sbc_cmd pbxng_sbc_cmd_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sbc_cmd
    ADD CONSTRAINT pbxng_sbc_cmd_pkey PRIMARY KEY (id);


--
-- Name: pbxng_sbc pbxng_sbc_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sbc
    ADD CONSTRAINT pbxng_sbc_pkey PRIMARY KEY (id);


--
-- Name: pbxng_sbc_routes pbxng_sbc_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sbc_routes
    ADD CONSTRAINT pbxng_sbc_routes_pkey PRIMARY KEY (id);


--
-- Name: pbxng_settings pbxng_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_settings
    ADD CONSTRAINT pbxng_settings_pkey PRIMARY KEY (key);


--
-- Name: pbxng_sip_capture pbxng_sip_capture_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sip_capture
    ADD CONSTRAINT pbxng_sip_capture_pkey PRIMARY KEY (id);


--
-- Name: pbxng_sip_manip pbxng_sip_manip_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sip_manip
    ADD CONSTRAINT pbxng_sip_manip_pkey PRIMARY KEY (id);


--
-- Name: pbxng_survey_fields pbxng_survey_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_survey_fields
    ADD CONSTRAINT pbxng_survey_fields_pkey PRIMARY KEY (id);


--
-- Name: pbxng_sysprompts pbxng_sysprompts_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_sysprompts
    ADD CONSTRAINT pbxng_sysprompts_pkey PRIMARY KEY (name);


--
-- Name: pbxng_trunks pbxng_trunks_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_trunks
    ADD CONSTRAINT pbxng_trunks_name_key UNIQUE (name);


--
-- Name: pbxng_trunks pbxng_trunks_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_trunks
    ADD CONSTRAINT pbxng_trunks_pkey PRIMARY KEY (id);


--
-- Name: pbxng_users pbxng_users_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_users
    ADD CONSTRAINT pbxng_users_pkey PRIMARY KEY (id);


--
-- Name: pbxng_users pbxng_users_username_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_users
    ADD CONSTRAINT pbxng_users_username_key UNIQUE (username);


--
-- Name: pbxng_wsbridge_status pbxng_wsbridge_status_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_wsbridge_status
    ADD CONSTRAINT pbxng_wsbridge_status_pkey PRIMARY KEY (name);


--
-- Name: ps_aors ps_aors_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_aors
    ADD CONSTRAINT ps_aors_id_key UNIQUE (id);


--
-- Name: ps_asterisk_publications ps_asterisk_publications_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_asterisk_publications
    ADD CONSTRAINT ps_asterisk_publications_id_key UNIQUE (id);


--
-- Name: ps_auths ps_auths_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_auths
    ADD CONSTRAINT ps_auths_id_key UNIQUE (id);


--
-- Name: ps_contacts ps_contacts_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_contacts
    ADD CONSTRAINT ps_contacts_id_key UNIQUE (id);


--
-- Name: ps_contacts ps_contacts_uq; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_contacts
    ADD CONSTRAINT ps_contacts_uq UNIQUE (id, reg_server);


--
-- Name: ps_domain_aliases ps_domain_aliases_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_domain_aliases
    ADD CONSTRAINT ps_domain_aliases_id_key UNIQUE (id);


--
-- Name: ps_endpoint_id_ips ps_endpoint_id_ips_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_endpoint_id_ips
    ADD CONSTRAINT ps_endpoint_id_ips_id_key UNIQUE (id);


--
-- Name: ps_endpoints ps_endpoints_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_endpoints
    ADD CONSTRAINT ps_endpoints_id_key UNIQUE (id);


--
-- Name: ps_globals ps_globals_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_globals
    ADD CONSTRAINT ps_globals_id_key UNIQUE (id);


--
-- Name: ps_inbound_publications ps_inbound_publications_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_inbound_publications
    ADD CONSTRAINT ps_inbound_publications_id_key UNIQUE (id);


--
-- Name: ps_outbound_publishes ps_outbound_publishes_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_outbound_publishes
    ADD CONSTRAINT ps_outbound_publishes_id_key UNIQUE (id);


--
-- Name: ps_registrations ps_registrations_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_registrations
    ADD CONSTRAINT ps_registrations_id_key UNIQUE (id);


--
-- Name: ps_resource_list ps_resource_list_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_resource_list
    ADD CONSTRAINT ps_resource_list_id_key UNIQUE (id);


--
-- Name: ps_subscription_persistence ps_subscription_persistence_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_subscription_persistence
    ADD CONSTRAINT ps_subscription_persistence_id_key UNIQUE (id);


--
-- Name: ps_systems ps_systems_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_systems
    ADD CONSTRAINT ps_systems_id_key UNIQUE (id);


--
-- Name: ps_transports ps_transports_id_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.ps_transports
    ADD CONSTRAINT ps_transports_id_key UNIQUE (id);


--
-- Name: queue_members queue_members_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.queue_members
    ADD CONSTRAINT queue_members_pkey PRIMARY KEY (queue_name, interface);


--
-- Name: queue_members queue_members_uniqueid_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.queue_members
    ADD CONSTRAINT queue_members_uniqueid_key UNIQUE (uniqueid);


--
-- Name: queues queues_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.queues
    ADD CONSTRAINT queues_pkey PRIMARY KEY (name);


--
-- Name: secfilter secfilter_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.secfilter
    ADD CONSTRAINT secfilter_pkey PRIMARY KEY (id);


--
-- Name: sippeers sippeers_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.sippeers
    ADD CONSTRAINT sippeers_name_key UNIQUE (name);


--
-- Name: sippeers sippeers_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.sippeers
    ADD CONSTRAINT sippeers_pkey PRIMARY KEY (id);


--
-- Name: stir_tn stir_tn_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.stir_tn
    ADD CONSTRAINT stir_tn_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_name_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_name_key UNIQUE (name);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: uacreg uacreg_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.uacreg
    ADD CONSTRAINT uacreg_pkey PRIMARY KEY (id);


--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (id);


--
-- Name: voicemail voicemail_pkey; Type: CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.voicemail
    ADD CONSTRAINT voicemail_pkey PRIMARY KEY (uniqueid);


--
-- Name: iaxfriends_host_port; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX iaxfriends_host_port ON public.iaxfriends USING btree (host, port);


--
-- Name: iaxfriends_ipaddr_port; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX iaxfriends_ipaddr_port ON public.iaxfriends USING btree (ipaddr, port);


--
-- Name: iaxfriends_name; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX iaxfriends_name ON public.iaxfriends USING btree (name);


--
-- Name: iaxfriends_name_host; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX iaxfriends_name_host ON public.iaxfriends USING btree (name, host);


--
-- Name: iaxfriends_name_ipaddr_port; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX iaxfriends_name_ipaddr_port ON public.iaxfriends USING btree (name, ipaddr, port);


--
-- Name: meetme_confno_start_end; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX meetme_confno_start_end ON public.meetme USING btree (confno, starttime, endtime);


--
-- Name: pbxng_sip_capture_cid; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX pbxng_sip_capture_cid ON public.pbxng_sip_capture USING btree (callid);


--
-- Name: pbxng_sip_capture_ts; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX pbxng_sip_capture_ts ON public.pbxng_sip_capture USING btree (id DESC);


--
-- Name: ps_aors_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_aors_id ON public.ps_aors USING btree (id);


--
-- Name: ps_aors_qualifyfreq_contact; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_aors_qualifyfreq_contact ON public.ps_aors USING btree (qualify_frequency, contact);


--
-- Name: ps_asterisk_publications_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_asterisk_publications_id ON public.ps_asterisk_publications USING btree (id);


--
-- Name: ps_auths_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_auths_id ON public.ps_auths USING btree (id);


--
-- Name: ps_contacts_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_contacts_id ON public.ps_contacts USING btree (id);


--
-- Name: ps_contacts_qualifyfreq_exp; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_contacts_qualifyfreq_exp ON public.ps_contacts USING btree (qualify_frequency, expiration_time);


--
-- Name: ps_domain_aliases_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_domain_aliases_id ON public.ps_domain_aliases USING btree (id);


--
-- Name: ps_endpoint_id_ips_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_endpoint_id_ips_id ON public.ps_endpoint_id_ips USING btree (id);


--
-- Name: ps_endpoints_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_endpoints_id ON public.ps_endpoints USING btree (id);


--
-- Name: ps_globals_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_globals_id ON public.ps_globals USING btree (id);


--
-- Name: ps_inbound_publications_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_inbound_publications_id ON public.ps_inbound_publications USING btree (id);


--
-- Name: ps_outbound_publishes_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_outbound_publishes_id ON public.ps_outbound_publishes USING btree (id);


--
-- Name: ps_registrations_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_registrations_id ON public.ps_registrations USING btree (id);


--
-- Name: ps_resource_list_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_resource_list_id ON public.ps_resource_list USING btree (id);


--
-- Name: ps_subscription_persistence_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_subscription_persistence_id ON public.ps_subscription_persistence USING btree (id);


--
-- Name: ps_systems_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_systems_id ON public.ps_systems USING btree (id);


--
-- Name: ps_transports_id; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX ps_transports_id ON public.ps_transports USING btree (id);


--
-- Name: secfilter_ux; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE UNIQUE INDEX secfilter_ux ON public.secfilter USING btree (action, type, data);


--
-- Name: sippeers_host_port; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX sippeers_host_port ON public.sippeers USING btree (host, port);


--
-- Name: sippeers_ipaddr_port; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX sippeers_ipaddr_port ON public.sippeers USING btree (ipaddr, port);


--
-- Name: sippeers_name; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX sippeers_name ON public.sippeers USING btree (name);


--
-- Name: sippeers_name_host; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX sippeers_name_host ON public.sippeers USING btree (name, host);


--
-- Name: uacreg_idx; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE UNIQUE INDEX uacreg_idx ON public.uacreg USING btree (l_uuid);


--
-- Name: version_tn_idx; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE UNIQUE INDEX version_tn_idx ON public.version USING btree (table_name);


--
-- Name: voicemail_context; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX voicemail_context ON public.voicemail USING btree (context);


--
-- Name: voicemail_imapuser; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX voicemail_imapuser ON public.voicemail USING btree (imapuser);


--
-- Name: voicemail_mailbox; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX voicemail_mailbox ON public.voicemail USING btree (mailbox);


--
-- Name: voicemail_mailbox_context; Type: INDEX; Schema: public; Owner: pbxng
--

CREATE INDEX voicemail_mailbox_context ON public.voicemail USING btree (mailbox, context);


--
-- Name: musiconhold_entry fk_musiconhold_entry_name_musiconhold; Type: FK CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.musiconhold_entry
    ADD CONSTRAINT fk_musiconhold_entry_name_musiconhold FOREIGN KEY (name) REFERENCES public.musiconhold(name);


--
-- Name: pbxng_client_devices pbxng_client_devices_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_devices
    ADD CONSTRAINT pbxng_client_devices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pbxng_clients(id) ON DELETE CASCADE;


--
-- Name: pbxng_client_persons pbxng_client_persons_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_persons
    ADD CONSTRAINT pbxng_client_persons_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pbxng_clients(id) ON DELETE CASCADE;


--
-- Name: pbxng_client_spaces pbxng_client_spaces_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_client_spaces
    ADD CONSTRAINT pbxng_client_spaces_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pbxng_clients(id) ON DELETE CASCADE;


--
-- Name: pbxng_ivr_options pbxng_ivr_options_ivr_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: pbxng
--

ALTER TABLE ONLY public.pbxng_ivr_options
    ADD CONSTRAINT pbxng_ivr_options_ivr_id_fkey FOREIGN KEY (ivr_id) REFERENCES public.pbxng_ivr(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 61QoG27gRb3cSgQqQKNAMnE517g3NwN1IhGlFnybR7ky2aTWR699lSu8Bh2Mlei

