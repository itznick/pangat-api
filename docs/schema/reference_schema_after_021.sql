--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

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
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: ingredients_unit_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ingredients_unit_enum AS ENUM (
    'KG',
    'GRAM',
    'LITRE',
    'ML',
    'PIECE',
    'PACKET'
);


--
-- Name: modifiers_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.modifiers_type_enum AS ENUM (
    'SINGLE',
    'MULTIPLE'
);


--
-- Name: orders_order_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_order_status_enum AS ENUM (
    'RECEIVED',
    'PREPARING',
    'READY',
    'DISPATCHED',
    'COMPLETED',
    'CANCELLED'
);


--
-- Name: orders_order_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_order_type_enum AS ENUM (
    'DINE_IN',
    'TAKEAWAY',
    'DELIVERY'
);


--
-- Name: orders_payment_method_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_payment_method_enum AS ENUM (
    'UPI_INSTANT',
    'PAY_AT_COUNTER',
    'COD'
);


--
-- Name: orders_payment_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_payment_status_enum AS ENUM (
    'PENDING',
    'PAID',
    'FAILED',
    'REFUND_PENDING',
    'PARTIALLY_REFUNDED',
    'REFUNDED'
);


--
-- Name: organization_subscriptions_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_subscriptions_status_enum AS ENUM (
    'TRIAL',
    'ACTIVE',
    'PAST_DUE',
    'GRACE_PERIOD',
    'HALTED',
    'CANCELLED',
    'EXPIRED'
);


--
-- Name: recipe_ingredients_unit_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recipe_ingredients_unit_enum AS ENUM (
    'KG',
    'GRAM',
    'LITRE',
    'ML',
    'PIECE',
    'PACKET'
);


--
-- Name: stock_movements_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.stock_movements_type_enum AS ENUM (
    'OPENING_STOCK',
    'RECEIVED',
    'MANUAL_ADJUSTMENT',
    'ORDER_CONSUMPTION',
    'ORDER_CANCELLATION_REVERSAL',
    'WASTAGE'
);


--
-- Name: subscription_invoices_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_invoices_status_enum AS ENUM (
    'DRAFT',
    'PAID',
    'FAILED',
    'REFUNDED'
);


--
-- Name: subscription_plans_billing_interval_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_plans_billing_interval_enum AS ENUM (
    'MONTHLY',
    'YEARLY'
);


--
-- Name: tables_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tables_status_enum AS ENUM (
    'VACANT',
    'OCCUPIED',
    'PREPPING',
    'SERVED'
);


--
-- Name: audit_logs_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_logs_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP USING ERRCODE = 'P0001';
END;
$$;


--
-- Name: platform_audit_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.platform_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only: % is not permitted', TG_OP;
END;
$$;


--
-- Name: tax_documents_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tax_documents_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'tax_documents is append-only: % is not permitted', TG_OP USING ERRCODE = 'P0001';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    body text NOT NULL,
    kind character varying(20) DEFAULT 'ANNOUNCEMENT'::character varying NOT NULL,
    severity character varying(10) DEFAULT 'INFO'::character varying NOT NULL,
    audience character varying(20) DEFAULT 'ALL'::character varying NOT NULL,
    organization_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    dismissible boolean DEFAULT true NOT NULL,
    created_by character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid,
    organization_id uuid,
    actor_email character varying(180),
    ip character varying(64),
    user_agent character varying(255),
    request_id character varying(64),
    entity_type character varying(50) NOT NULL,
    entity_id character varying(100) NOT NULL,
    action character varying(50) NOT NULL,
    staff_id uuid,
    staff_name character varying(100),
    staff_role character varying(50),
    reason text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: data_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    scope character varying(20) NOT NULL,
    kind character varying(40) NOT NULL,
    requested_by uuid,
    requested_by_name character varying(120),
    status character varying(10) DEFAULT 'COMPLETED'::character varying NOT NULL,
    row_counts jsonb,
    bytes integer,
    checksum character varying(80),
    filters jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_sequences (
    restaurant_id uuid NOT NULL,
    kind character varying(12) NOT NULL,
    fiscal_year character varying(4) NOT NULL,
    last_value integer DEFAULT 0 NOT NULL
);


--
-- Name: error_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method character varying(10),
    path character varying(300),
    status integer NOT NULL,
    error_name character varying(100),
    message text,
    stack text,
    user_id uuid,
    organization_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id character varying(64)
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    feature_key character varying(60) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    description text,
    updated_by character varying(120),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: health_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_snapshots (
    id bigint NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    db_ok boolean NOT NULL,
    db_latency_ms integer,
    heap_mb integer,
    rss_mb integer,
    api_requests integer,
    api_errors integer,
    p95_ms integer,
    ws_clients integer
);


--
-- Name: health_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.health_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: health_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.health_snapshots_id_seq OWNED BY public.health_snapshots.id;


--
-- Name: ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredients (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    name character varying(150) NOT NULL,
    sku character varying(60),
    unit public.ingredients_unit_enum DEFAULT 'KG'::public.ingredients_unit_enum NOT NULL,
    current_stock numeric(12,3) DEFAULT '0'::numeric NOT NULL,
    minimum_stock numeric(12,3) DEFAULT '0'::numeric NOT NULL,
    cost_per_unit numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_name character varying(60) NOT NULL,
    status character varying(10) NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer,
    result jsonb,
    error text
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(150) NOT NULL,
    restaurant_name character varying(180) NOT NULL,
    phone character varying(40) NOT NULL,
    city character varying(100) NOT NULL,
    table_count character varying(50) DEFAULT '10'::character varying NOT NULL,
    status character varying(30) DEFAULT 'NEW'::character varying NOT NULL,
    notes text,
    consent_version character varying(20),
    consent_at timestamp with time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: login_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid,
    email character varying(180),
    success boolean NOT NULL,
    reason character varying(60),
    is_platform_admin boolean DEFAULT false NOT NULL,
    organization_id uuid,
    ip character varying(64),
    user_agent character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: menu_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    category_id uuid,
    name character varying(200) NOT NULL,
    description text,
    price numeric(10,2) NOT NULL,
    is_veg boolean DEFAULT true NOT NULL,
    is_available boolean DEFAULT true NOT NULL,
    is_popular boolean DEFAULT false NOT NULL,
    image_url character varying(20),
    auto_disabled boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifiers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    menu_item_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    type public.modifiers_type_enum DEFAULT 'SINGLE'::public.modifiers_type_enum NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    channel character varying(10) NOT NULL,
    staff_id uuid,
    organization_id uuid,
    recipient_email character varying(180),
    status character varying(12) NOT NULL,
    error text,
    provider_message_id character varying(150),
    rendered_subject character varying(200),
    rendered_body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key character varying(60) NOT NULL,
    name character varying(120) NOT NULL,
    channel character varying(10) DEFAULT 'EMAIL'::character varying NOT NULL,
    subject character varying(200) NOT NULL,
    body text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_by character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    order_id character varying(20) NOT NULL,
    menu_item_id character varying(50),
    name character varying(200) NOT NULL,
    price numeric(10,2) NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    selected_modifiers jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text
);


--
-- Name: order_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id character varying(20) NOT NULL,
    restaurant_id uuid NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    request_hash character(64) NOT NULL,
    method character varying(20) NOT NULL,
    amount numeric(10,2) NOT NULL,
    reason text NOT NULL,
    credit_note_number character varying(32),
    provider_reference character varying(120),
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_refunds_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id character varying(20) NOT NULL,
    tracking_token character varying(64),
    restaurant_id uuid NOT NULL,
    order_type public.orders_order_type_enum DEFAULT 'DINE_IN'::public.orders_order_type_enum NOT NULL,
    table_number character varying(10),
    customer_name character varying(100),
    customer_phone character varying(15),
    bill_number character varying(16),
    bill_issued_at timestamp with time zone,
    consent_version character varying(20),
    consent_at timestamp with time zone,
    delivery_address text,
    delivery_instructions text,
    delivery_fee numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    dispatched_at timestamp with time zone,
    delivered_at timestamp with time zone,
    dispatched_by_staff_id uuid,
    order_status public.orders_order_status_enum DEFAULT 'RECEIVED'::public.orders_order_status_enum NOT NULL,
    payment_status public.orders_payment_status_enum DEFAULT 'PENDING'::public.orders_payment_status_enum NOT NULL,
    payment_method public.orders_payment_method_enum,
    subtotal numeric(10,2) NOT NULL,
    gst_amount numeric(10,2) NOT NULL,
    service_charge_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(10,2) NOT NULL,
    request_hash character(64),
    idempotency_key character varying(100) NOT NULL,
    settled_at timestamp with time zone,
    preparing_at timestamp with time zone,
    ready_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancellation_reason text,
    cancelled_at timestamp with time zone,
    cancelled_by_staff_id uuid,
    refund_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    refund_reason text,
    refunded_at timestamp with time zone,
    refunded_by_staff_id uuid,
    version integer DEFAULT 1 NOT NULL,
    feedback jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_feature_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_feature_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    feature_key character varying(60) NOT NULL,
    mode character varying(10) NOT NULL,
    reason text,
    set_by character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    author_id uuid,
    author_name character varying(120),
    body text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_subscriptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    organization_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status public.organization_subscriptions_status_enum DEFAULT 'TRIAL'::public.organization_subscriptions_status_enum NOT NULL,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    trial_ends_at timestamp with time zone,
    grace_period_ends_at timestamp with time zone,
    razorpay_subscription_id character varying(100),
    razorpay_customer_id character varying(100),
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    source character varying(20) DEFAULT 'GATEWAY'::character varying NOT NULL,
    assigned_by character varying(120),
    cancelled_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(140) NOT NULL,
    owner_id uuid,
    billing_legal_name character varying(200),
    billing_address text,
    billing_state_code character varying(2),
    billing_gstin character varying(15),
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    status_reason text,
    status_changed_at timestamp with time zone,
    status_changed_by character varying(120),
    verification_status character varying(20) DEFAULT 'UNVERIFIED'::character varying NOT NULL,
    verified_at timestamp with time zone,
    verified_by character varying(120),
    verification_note text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: otp_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purpose character varying(30) NOT NULL,
    identifier character varying(180) NOT NULL,
    code_hash character varying(128) NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plan_feature_backfills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_feature_backfills (
    plan_id uuid NOT NULL,
    feature character varying(50) NOT NULL,
    migration character varying(20) NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plan_visibility_backfills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_visibility_backfills (
    plan_id uuid NOT NULL,
    previous_is_public boolean NOT NULL,
    migration character varying(20) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    actor_name character varying(120),
    actor_email character varying(180),
    actor_role character varying(30),
    action character varying(60) NOT NULL,
    category character varying(30) DEFAULT 'SYSTEM'::character varying NOT NULL,
    entity_type character varying(40),
    entity_id character varying(100),
    entity_label character varying(200),
    organization_id uuid,
    summary text,
    changes jsonb,
    reason text,
    ip character varying(64),
    user_agent character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_event_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_event_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    channel character varying(10) DEFAULT 'EMAIL'::character varying NOT NULL,
    recipient character varying(180) DEFAULT ''::character varying NOT NULL,
    status character varying(10) DEFAULT 'PENDING'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    provider character varying(20),
    message_id character varying(200),
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_delivery_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'SENDING'::character varying, 'SENT'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: platform_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(60) NOT NULL,
    severity character varying(10) DEFAULT 'INFO'::character varying NOT NULL,
    title character varying(200) NOT NULL,
    detail text,
    organization_id uuid,
    entity_type character varying(40),
    entity_id character varying(100),
    actor_name character varying(120),
    acknowledged_at timestamp with time zone,
    acknowledged_by character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject character varying(200) NOT NULL,
    body text NOT NULL,
    channels text[] DEFAULT '{}'::text[] NOT NULL,
    audience character varying(20) NOT NULL,
    target_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    template_key character varying(60),
    status character varying(15) DEFAULT 'SENDING'::character varying NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    delivered integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_by_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key character varying(100) NOT NULL,
    value jsonb,
    encrypted text,
    is_secret boolean DEFAULT false NOT NULL,
    updated_by character varying(120),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: privacy_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.privacy_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference character varying(20) NOT NULL,
    kind character varying(24) NOT NULL,
    name character varying(120) NOT NULL,
    contact character varying(180) NOT NULL,
    restaurant_ref character varying(120),
    message text,
    status character varying(16) DEFAULT 'OPEN'::character varying NOT NULL,
    due_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    resolution_note text,
    handled_by character varying(120),
    consent_version character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recipe_ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_ingredients (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    recipe_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL,
    unit public.recipe_ingredients_unit_enum DEFAULT 'KG'::public.recipe_ingredients_unit_enum NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    menu_item_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    organization_id uuid,
    name character varying(120) NOT NULL,
    slug character varying(80) NOT NULL,
    branch_area character varying(140),
    phone character varying(30),
    email character varying(180),
    is_active boolean DEFAULT true NOT NULL,
    upi_vpa character varying(80) NOT NULL,
    upi_vpa_confirmed_at timestamp with time zone,
    onboarding jsonb DEFAULT '{}'::jsonb NOT NULL,
    upi_vpa_confirmed_by uuid,
    gstin character varying(20),
    fssai_license character varying(14),
    invoice_prefix character varying(4),
    hsn_sac character varying(10) DEFAULT '9963'::character varying NOT NULL,
    gst_percentage numeric(5,2) DEFAULT '5'::numeric NOT NULL,
    service_charge_percentage numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    is_veg_only boolean DEFAULT false NOT NULL,
    kds_new_order_alert boolean DEFAULT true NOT NULL,
    order_ready_chime boolean DEFAULT true NOT NULL,
    out_of_stock_notification boolean DEFAULT true NOT NULL,
    auto_deduct_inventory boolean DEFAULT true NOT NULL,
    operations jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(120) NOT NULL,
    email character varying(180) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(30) DEFAULT 'SUPER_OWNER'::character varying NOT NULL,
    is_platform_admin boolean DEFAULT false NOT NULL,
    platform_role character varying(30),
    platform_permissions jsonb,
    organization_id uuid,
    restaurant_id uuid,
    pin_code character varying(10),
    phone character varying(30),
    pin_hash character varying(255),
    is_active boolean DEFAULT true NOT NULL,
    password_changed_at timestamp with time zone,
    totp_secret_enc text,
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_enabled_at timestamp with time zone,
    totp_last_step bigint,
    totp_recovery_hashes jsonb,
    must_change_password boolean DEFAULT false NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    reset_token_hash character varying(255),
    reset_token_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    type public.stock_movements_type_enum NOT NULL,
    quantity numeric(12,3) NOT NULL,
    balance_after numeric(12,3) NOT NULL,
    reason character varying(255) NOT NULL,
    reference_order_id character varying(50),
    actor_staff_id uuid,
    idempotency_key character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    organization_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    actor character varying(100),
    reason text,
    metadata jsonb,
    idempotency_key character varying(150),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_invoice_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_invoice_sequences (
    fiscal_year character varying(4) NOT NULL,
    last_value bigint DEFAULT 0 NOT NULL
);


--
-- Name: subscription_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_invoices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    organization_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    invoice_number character varying(50) NOT NULL,
    billing_period_start timestamp with time zone NOT NULL,
    billing_period_end timestamp with time zone NOT NULL,
    base_amount numeric(10,2) NOT NULL,
    tax_percentage numeric(5,2) DEFAULT '18'::numeric NOT NULL,
    tax_amount numeric(10,2) NOT NULL,
    total_amount numeric(10,2) NOT NULL,
    base_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    tax_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    total_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    cgst_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    sgst_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    igst_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    state_code character varying(10),
    buyer_gstin character varying(20),
    status public.subscription_invoices_status_enum DEFAULT 'DRAFT'::public.subscription_invoices_status_enum NOT NULL,
    razorpay_payment_id character varying(100),
    razorpay_invoice_id character varying(100),
    gateway character varying(30) DEFAULT 'razorpay'::character varying NOT NULL,
    payment_method character varying(30),
    failure_reason text,
    refunded_amount_paise bigint DEFAULT '0'::bigint NOT NULL,
    refunded_at timestamp with time zone,
    paid_at timestamp with time zone,
    invoice_pdf_url text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    billing_interval public.subscription_plans_billing_interval_enum DEFAULT 'MONTHLY'::public.subscription_plans_billing_interval_enum NOT NULL,
    base_price numeric(10,2) NOT NULL,
    base_price_paise bigint DEFAULT '0'::bigint NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    tax_percentage numeric(5,2) DEFAULT '18'::numeric NOT NULL,
    max_outlets integer DEFAULT 1 NOT NULL,
    max_tables_per_outlet integer DEFAULT 10 NOT NULL,
    max_staff_per_outlet integer DEFAULT 5 NOT NULL,
    sac_code character varying(20),
    features text DEFAULT ''::text NOT NULL,
    trial_days integer DEFAULT 14 NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    razorpay_plan_id character varying(100),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: support_ticket_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_ticket_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    type character varying(20) NOT NULL,
    author_id uuid,
    author_name character varying(120),
    author_kind character varying(10) DEFAULT 'ADMIN'::character varying NOT NULL,
    body text,
    internal boolean DEFAULT false NOT NULL,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_ticket_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_ticket_seq
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    number integer DEFAULT nextval('public.support_ticket_seq'::regclass) NOT NULL,
    organization_id uuid,
    restaurant_id uuid,
    reporter_staff_id uuid,
    reporter_name character varying(120),
    reporter_email character varying(180),
    category character varying(20) DEFAULT 'SUPPORT'::character varying NOT NULL,
    subject character varying(200) NOT NULL,
    description text NOT NULL,
    priority character varying(10) DEFAULT 'MEDIUM'::character varying NOT NULL,
    status character varying(15) DEFAULT 'OPEN'::character varying NOT NULL,
    assignee_id uuid,
    assignee_name character varying(120),
    resolution text,
    source character varying(12) DEFAULT 'RESTAURANT'::character varying NOT NULL,
    first_response_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tables (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    restaurant_id uuid NOT NULL,
    table_number character varying(10) NOT NULL,
    qr_code_url character varying(255),
    status public.tables_status_enum DEFAULT 'VACANT'::public.tables_status_enum NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tax_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    order_id character varying(20) NOT NULL,
    kind character varying(12) NOT NULL,
    number character varying(16) NOT NULL,
    fiscal_year character varying(4) NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text,
    issued_by character varying(120),
    issued_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider character varying(30) DEFAULT 'razorpay'::character varying NOT NULL,
    event_id character varying(150),
    event_type character varying(100),
    status character varying(20) NOT NULL,
    http_status integer,
    error text,
    organization_id uuid,
    payment_id character varying(100),
    signature_valid boolean,
    summary jsonb,
    processing_ms integer,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: health_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_snapshots ALTER COLUMN id SET DEFAULT nextval('public.health_snapshots_id_seq'::regclass);


--
-- Name: order_items PK_005269d8574e6fac0493715c308; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY (id);


--
-- Name: menu_categories PK_124ae987900336f983881cb04e6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT "PK_124ae987900336f983881cb04e6" PRIMARY KEY (id);


--
-- Name: audit_logs PK_1bb179d048bbc581caa3b013439; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY (id);


--
-- Name: stock_movements PK_57a26b190618550d8e65fb860e7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "PK_57a26b190618550d8e65fb860e7" PRIMARY KEY (id);


--
-- Name: menu_items PK_57e6188f929e5dc6919168620c8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT "PK_57e6188f929e5dc6919168620c8" PRIMARY KEY (id);


--
-- Name: organization_subscriptions PK_64e17f1dc8ebe056b49e751a494; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_subscriptions
    ADD CONSTRAINT "PK_64e17f1dc8ebe056b49e751a494" PRIMARY KEY (id);


--
-- Name: organizations PK_6b031fcd0863e3f6b44230163f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT "PK_6b031fcd0863e3f6b44230163f9" PRIMARY KEY (id);


--
-- Name: subscription_invoices PK_7050ae7d81f0f0207b8f1cd2efc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT "PK_7050ae7d81f0f0207b8f1cd2efc" PRIMARY KEY (id);


--
-- Name: orders PK_710e2d4957aa5878dfe94e4ac2f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY (id);


--
-- Name: tables PK_7cf2aca7af9550742f855d4eb69; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT "PK_7cf2aca7af9550742f855d4eb69" PRIMARY KEY (id);


--
-- Name: recipes PK_8f09680a51bf3669c1598a21682; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT "PK_8f09680a51bf3669c1598a21682" PRIMARY KEY (id);


--
-- Name: recipe_ingredients PK_8f15a314e55970414fc92ffb532; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT "PK_8f15a314e55970414fc92ffb532" PRIMARY KEY (id);


--
-- Name: ingredients PK_9240185c8a5507251c9f15e0649; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT "PK_9240185c8a5507251c9f15e0649" PRIMARY KEY (id);


--
-- Name: subscription_plans PK_9ab8fe6918451ab3d0a4fb6bb0c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT "PK_9ab8fe6918451ab3d0a4fb6bb0c" PRIMARY KEY (id);


--
-- Name: subscription_audit_logs PK_a1672fbba8f29b4ff042b926abe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_audit_logs
    ADD CONSTRAINT "PK_a1672fbba8f29b4ff042b926abe" PRIMARY KEY (id);


--
-- Name: leads PK_cd102ed7a9a4ca7d4d8bfeba406; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT "PK_cd102ed7a9a4ca7d4d8bfeba406" PRIMARY KEY (id);


--
-- Name: restaurants PK_e2133a72eb1cc8f588f7b503e68; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT "PK_e2133a72eb1cc8f588f7b503e68" PRIMARY KEY (id);


--
-- Name: staff PK_e4ee98bb552756c180aec1e854a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT "PK_e4ee98bb552756c180aec1e854a" PRIMARY KEY (id);


--
-- Name: modifiers PK_f4d68e3a0c8a835c06a9fa27f7e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT "PK_f4d68e3a0c8a835c06a9fa27f7e" PRIMARY KEY (id);


--
-- Name: subscription_plans UQ_2d2df70a81d37c893ef216caf8a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT "UQ_2d2df70a81d37c893ef216caf8a" UNIQUE (code);


--
-- Name: orders UQ_59d6b7756aeb6cbb43a093d15a1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "UQ_59d6b7756aeb6cbb43a093d15a1" UNIQUE (idempotency_key);


--
-- Name: subscription_invoices UQ_6c62b1deceda54a99b61dec8857; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT "UQ_6c62b1deceda54a99b61dec8857" UNIQUE (invoice_number);


--
-- Name: staff UQ_902985a964245652d5e3a0f5f6a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT "UQ_902985a964245652d5e3a0f5f6a" UNIQUE (email);


--
-- Name: restaurants UQ_afb6330c019768b4c3f9a65303c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT "UQ_afb6330c019768b4c3f9a65303c" UNIQUE (slug);


--
-- Name: stock_movements UQ_f323187a6c4d4529a5251856126; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "UQ_f323187a6c4d4529a5251856126" UNIQUE (idempotency_key);


--
-- Name: orders UQ_fbfeba6de4a6ffaabb9db558c80; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "UQ_fbfeba6de4a6ffaabb9db558c80" UNIQUE (tracking_token);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: menu_items chk_menu_items_price_nonneg; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.menu_items
    ADD CONSTRAINT chk_menu_items_price_nonneg CHECK ((price >= (0)::numeric)) NOT VALID;


--
-- Name: order_items chk_order_items_qty_positive; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.order_items
    ADD CONSTRAINT chk_order_items_qty_positive CHECK ((quantity > 0)) NOT VALID;


--
-- Name: orders chk_orders_amounts_nonneg; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.orders
    ADD CONSTRAINT chk_orders_amounts_nonneg CHECK (((subtotal >= (0)::numeric) AND (total_amount >= (0)::numeric) AND (refund_amount >= (0)::numeric))) NOT VALID;


--
-- Name: orders chk_orders_refund_within_total; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.orders
    ADD CONSTRAINT chk_orders_refund_within_total CHECK ((refund_amount <= total_amount)) NOT VALID;


--
-- Name: restaurants chk_restaurants_gst_range; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.restaurants
    ADD CONSTRAINT chk_restaurants_gst_range CHECK (((gst_percentage >= (0)::numeric) AND (gst_percentage <= (28)::numeric))) NOT VALID;


--
-- Name: restaurants chk_restaurants_service_charge_range; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.restaurants
    ADD CONSTRAINT chk_restaurants_service_charge_range CHECK (((service_charge_percentage >= (0)::numeric) AND (service_charge_percentage <= (20)::numeric))) NOT VALID;


--
-- Name: data_exports data_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_pkey PRIMARY KEY (id);


--
-- Name: document_sequences document_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sequences
    ADD CONSTRAINT document_sequences_pkey PRIMARY KEY (restaurant_id, kind, fiscal_year);


--
-- Name: error_logs error_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (feature_key);


--
-- Name: health_snapshots health_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_snapshots
    ADD CONSTRAINT health_snapshots_pkey PRIMARY KEY (id);


--
-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);


--
-- Name: login_events login_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_events
    ADD CONSTRAINT login_events_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_key_key UNIQUE (key);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: order_refunds order_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_refunds
    ADD CONSTRAINT order_refunds_pkey PRIMARY KEY (id);


--
-- Name: org_feature_overrides org_feature_overrides_organization_id_feature_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_feature_overrides
    ADD CONSTRAINT org_feature_overrides_organization_id_feature_key_key UNIQUE (organization_id, feature_key);


--
-- Name: org_feature_overrides org_feature_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_feature_overrides
    ADD CONSTRAINT org_feature_overrides_pkey PRIMARY KEY (id);


--
-- Name: organization_notes organization_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_notes
    ADD CONSTRAINT organization_notes_pkey PRIMARY KEY (id);


--
-- Name: otp_codes otp_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_pkey PRIMARY KEY (id);


--
-- Name: plan_feature_backfills plan_feature_backfills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_feature_backfills
    ADD CONSTRAINT plan_feature_backfills_pkey PRIMARY KEY (plan_id, feature, migration);


--
-- Name: plan_visibility_backfills plan_visibility_backfills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_visibility_backfills
    ADD CONSTRAINT plan_visibility_backfills_pkey PRIMARY KEY (plan_id);


--
-- Name: platform_audit_logs platform_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_logs
    ADD CONSTRAINT platform_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: platform_event_deliveries platform_event_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_event_deliveries
    ADD CONSTRAINT platform_event_deliveries_pkey PRIMARY KEY (id);


--
-- Name: platform_events platform_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_pkey PRIMARY KEY (id);


--
-- Name: platform_notifications platform_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_notifications
    ADD CONSTRAINT platform_notifications_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: privacy_requests privacy_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.privacy_requests
    ADD CONSTRAINT privacy_requests_pkey PRIMARY KEY (id);


--
-- Name: privacy_requests privacy_requests_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.privacy_requests
    ADD CONSTRAINT privacy_requests_reference_key UNIQUE (reference);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: subscription_invoice_sequences subscription_invoice_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoice_sequences
    ADD CONSTRAINT subscription_invoice_sequences_pkey PRIMARY KEY (fiscal_year);


--
-- Name: support_ticket_events support_ticket_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_events
    ADD CONSTRAINT support_ticket_events_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: tax_documents tax_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_pkey PRIMARY KEY (id);


--
-- Name: tax_documents tax_documents_restaurant_id_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_restaurant_id_number_key UNIQUE (restaurant_id, number);


--
-- Name: platform_event_deliveries uq_event_delivery; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_event_deliveries
    ADD CONSTRAINT uq_event_delivery UNIQUE (event_id, channel, recipient);


--
-- Name: order_refunds uq_order_refunds_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_refunds
    ADD CONSTRAINT uq_order_refunds_key UNIQUE (order_id, idempotency_key);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: IDX_0594d71e3d8af2586f7094b472; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0594d71e3d8af2586f7094b472" ON public.recipes USING btree (restaurant_id, menu_item_id, is_active);


--
-- Name: IDX_133545365243061dc2c55dc137; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_133545365243061dc2c55dc137" ON public.recipe_ingredients USING btree (ingredient_id);


--
-- Name: IDX_169b974755b6a8dd1c31a41de4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_169b974755b6a8dd1c31a41de4" ON public.recipes USING btree (restaurant_id, menu_item_id);


--
-- Name: IDX_2d2df70a81d37c893ef216caf8; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_2d2df70a81d37c893ef216caf8" ON public.subscription_plans USING btree (code);


--
-- Name: IDX_4970bf46b047d598a0d4163cd8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4970bf46b047d598a0d4163cd8" ON public.ingredients USING btree (restaurant_id, name);


--
-- Name: IDX_565dfe26ce6c52d53934552de5; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_565dfe26ce6c52d53934552de5" ON public.subscription_invoices USING btree (razorpay_payment_id);


--
-- Name: IDX_57ddc8b4e5e88ad07f8f325a47; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_57ddc8b4e5e88ad07f8f325a47" ON public.organization_subscriptions USING btree (razorpay_subscription_id);


--
-- Name: IDX_58c55a4a6fe5dd565f688849d7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_58c55a4a6fe5dd565f688849d7" ON public.subscription_audit_logs USING btree (organization_id, created_at);


--
-- Name: IDX_6c62b1deceda54a99b61dec885; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_6c62b1deceda54a99b61dec885" ON public.subscription_invoices USING btree (invoice_number);


--
-- Name: IDX_7a64fd3b3232dd98852ae48adf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7a64fd3b3232dd98852ae48adf" ON public.subscription_audit_logs USING btree (idempotency_key);


--
-- Name: IDX_9de64b96a7b441d6f8f9133f02; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9de64b96a7b441d6f8f9133f02" ON public.stock_movements USING btree (ingredient_id, created_at);


--
-- Name: IDX_a120d7fbf1ce4ea46c684325f4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a120d7fbf1ce4ea46c684325f4" ON public.stock_movements USING btree (restaurant_id, created_at);


--
-- Name: IDX_bc630c669b331a56884fa16e0f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_bc630c669b331a56884fa16e0f" ON public.subscription_invoices USING btree (organization_id, created_at);


--
-- Name: IDX_ee120ecc7d96135bd947a1ea7a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ee120ecc7d96135bd947a1ea7a" ON public.organization_subscriptions USING btree (organization_id);


--
-- Name: IDX_f240137e0e13bed80bdf64fed5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f240137e0e13bed80bdf64fed5" ON public.recipe_ingredients USING btree (recipe_id);


--
-- Name: idx_announcements_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_active ON public.announcements USING btree (is_active, starts_at DESC);


--
-- Name: idx_audit_logs_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_org_created ON public.audit_logs USING btree (organization_id, created_at DESC);


--
-- Name: idx_audit_logs_restaurant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_restaurant_created ON public.audit_logs USING btree (restaurant_id, created_at DESC);


--
-- Name: idx_audit_logs_restaurant_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_restaurant_entity ON public.audit_logs USING btree (restaurant_id, entity_type, entity_id, created_at);


--
-- Name: idx_audit_logs_staff_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_staff_created ON public.audit_logs USING btree (staff_id, created_at DESC);


--
-- Name: idx_data_exports_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_data_exports_created ON public.data_exports USING btree (created_at DESC);


--
-- Name: idx_error_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_created ON public.error_logs USING btree (created_at DESC);


--
-- Name: idx_error_logs_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_request ON public.error_logs USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: idx_event_deliveries_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_deliveries_due ON public.platform_event_deliveries USING btree (status, next_attempt_at);


--
-- Name: idx_health_snapshots_taken; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_health_snapshots_taken ON public.health_snapshots USING btree (taken_at DESC);


--
-- Name: idx_job_runs_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_runs_name ON public.job_runs USING btree (job_name, started_at DESC);


--
-- Name: idx_login_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_events_created ON public.login_events USING btree (created_at DESC);


--
-- Name: idx_login_events_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_events_staff ON public.login_events USING btree (staff_id, created_at DESC);


--
-- Name: idx_menu_categories_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_categories_restaurant ON public.menu_categories USING btree (restaurant_id);


--
-- Name: idx_menu_items_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_category ON public.menu_items USING btree (category_id);


--
-- Name: idx_menu_items_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_restaurant ON public.menu_items USING btree (restaurant_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_modifiers_menu_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modifiers_menu_item ON public.modifiers USING btree (menu_item_id);


--
-- Name: idx_notification_deliveries_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_deliveries_inbox ON public.notification_deliveries USING btree (staff_id, channel, created_at DESC);


--
-- Name: idx_notification_deliveries_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_deliveries_notification ON public.notification_deliveries USING btree (notification_id);


--
-- Name: idx_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order ON public.order_items USING btree (order_id);


--
-- Name: idx_order_refunds_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_refunds_order ON public.order_refunds USING btree (order_id);


--
-- Name: idx_orders_phone_digits; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_phone_digits ON public.orders USING btree ("right"(regexp_replace((customer_phone)::text, '\D'::text, ''::text, 'g'::text), 10)) WHERE (customer_phone IS NOT NULL);


--
-- Name: idx_orders_pii_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_pii_created ON public.orders USING btree (created_at) WHERE ((customer_phone IS NOT NULL) OR (customer_name IS NOT NULL) OR (delivery_address IS NOT NULL));


--
-- Name: idx_orders_restaurant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_created ON public.orders USING btree (restaurant_id, created_at);


--
-- Name: idx_orders_restaurant_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_payment ON public.orders USING btree (restaurant_id, payment_status, created_at DESC);


--
-- Name: idx_orders_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_status ON public.orders USING btree (restaurant_id, order_status);


--
-- Name: idx_org_notes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_notes_org ON public.organization_notes USING btree (organization_id, created_at DESC);


--
-- Name: idx_organizations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_status ON public.organizations USING btree (status);


--
-- Name: idx_otp_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_lookup ON public.otp_codes USING btree (purpose, identifier, created_at DESC);


--
-- Name: idx_pal_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pal_action ON public.platform_audit_logs USING btree (action, created_at DESC);


--
-- Name: idx_pal_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pal_actor ON public.platform_audit_logs USING btree (actor_id, created_at DESC);


--
-- Name: idx_pal_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pal_created ON public.platform_audit_logs USING btree (created_at DESC);


--
-- Name: idx_pal_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pal_org ON public.platform_audit_logs USING btree (organization_id, created_at DESC);


--
-- Name: idx_platform_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_events_created ON public.platform_events USING btree (created_at DESC);


--
-- Name: idx_platform_notifications_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_notifications_created ON public.platform_notifications USING btree (created_at DESC);


--
-- Name: idx_privacy_requests_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_privacy_requests_created ON public.privacy_requests USING btree (created_at DESC);


--
-- Name: idx_privacy_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_privacy_requests_status ON public.privacy_requests USING btree (status, due_at);


--
-- Name: idx_restaurants_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_organization ON public.restaurants USING btree (organization_id);


--
-- Name: idx_staff_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_organization ON public.staff USING btree (organization_id);


--
-- Name: idx_staff_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_restaurant ON public.staff USING btree (restaurant_id);


--
-- Name: idx_support_ticket_events_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_ticket_events_ticket ON public.support_ticket_events USING btree (ticket_id, created_at);


--
-- Name: idx_support_tickets_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_org ON public.support_tickets USING btree (organization_id, created_at DESC);


--
-- Name: idx_support_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_status ON public.support_tickets USING btree (status, created_at DESC);


--
-- Name: idx_tables_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_restaurant ON public.tables USING btree (restaurant_id);


--
-- Name: idx_tax_documents_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_documents_order ON public.tax_documents USING btree (order_id);


--
-- Name: idx_tax_documents_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_documents_restaurant ON public.tax_documents USING btree (restaurant_id, issued_at DESC);


--
-- Name: idx_webhook_events_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_received ON public.webhook_events USING btree (received_at DESC);


--
-- Name: idx_webhook_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_status ON public.webhook_events USING btree (status, received_at DESC);


--
-- Name: uq_orders_bill_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_orders_bill_number ON public.orders USING btree (restaurant_id, bill_number) WHERE (bill_number IS NOT NULL);


--
-- Name: uq_restaurants_invoice_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_restaurants_invoice_prefix ON public.restaurants USING btree (invoice_prefix) WHERE (invoice_prefix IS NOT NULL);


--
-- Name: uq_staff_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_staff_email_lower ON public.staff USING btree (lower((email)::text));


--
-- Name: uq_tables_restaurant_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tables_restaurant_number ON public.tables USING btree (restaurant_id, upper((table_number)::text));


--
-- Name: uq_tax_documents_bill_per_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tax_documents_bill_per_order ON public.tax_documents USING btree (order_id) WHERE ((kind)::text = 'BILL'::text);


--
-- Name: audit_logs trg_audit_logs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_logs_immutable BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();


--
-- Name: audit_logs trg_audit_logs_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_immutable();


--
-- Name: platform_audit_logs trg_platform_audit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_platform_audit_immutable BEFORE DELETE OR UPDATE ON public.platform_audit_logs FOR EACH ROW EXECUTE FUNCTION public.platform_audit_immutable();


--
-- Name: platform_audit_logs trg_platform_audit_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_platform_audit_no_truncate BEFORE TRUNCATE ON public.platform_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_immutable();


--
-- Name: tax_documents trg_tax_documents_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tax_documents_immutable BEFORE DELETE OR UPDATE ON public.tax_documents FOR EACH ROW EXECUTE FUNCTION public.tax_documents_immutable();


--
-- Name: tax_documents trg_tax_documents_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tax_documents_no_truncate BEFORE TRUNCATE ON public.tax_documents FOR EACH STATEMENT EXECUTE FUNCTION public.tax_documents_immutable();


--
-- Name: subscription_invoices FK_132d16d58c25fb6c47d18bb7478; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT "FK_132d16d58c25fb6c47d18bb7478" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: recipe_ingredients FK_133545365243061dc2c55dc1373; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT "FK_133545365243061dc2c55dc1373" FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: order_items FK_145532db85752b29c57d2b7b1f1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: staff FK_1b1658ba3bb205874b325403b08; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT "FK_1b1658ba3bb205874b325403b08" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE SET NULL;


--
-- Name: menu_items FK_20cff56c44dd4fe52d5aa2b96f8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT "FK_20cff56c44dd4fe52d5aa2b96f8" FOREIGN KEY (category_id) REFERENCES public.menu_categories(id) ON DELETE SET NULL;


--
-- Name: modifiers FK_39b3deea054ebf08e47e99e9140; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT "FK_39b3deea054ebf08e47e99e9140" FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: ingredients FK_3f3748c03ffce9383bc4760e1fa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT "FK_3f3748c03ffce9383bc4760e1fa" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: subscription_invoices FK_4f183991dc9bcbda39fa6141931; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT "FK_4f183991dc9bcbda39fa6141931" FOREIGN KEY (subscription_id) REFERENCES public.organization_subscriptions(id) ON DELETE CASCADE;


--
-- Name: restaurants FK_5a23a15034bbb14a44d7d14bc74; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT "FK_5a23a15034bbb14a44d7d14bc74" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: tables FK_77e362d578933cf4518770d11ae; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT "FK_77e362d578933cf4518770d11ae" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: recipes FK_813bfb78c7da6ed80ced1b110ae; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT "FK_813bfb78c7da6ed80ced1b110ae" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: orders FK_85fdda5fcce2f397ef8f117a2c6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "FK_85fdda5fcce2f397ef8f117a2c6" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: menu_items FK_8d1ee4780bf64ae94cbf3e53705; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT "FK_8d1ee4780bf64ae94cbf3e53705" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: stock_movements FK_990da5f8a5976f2d02cf60fbdcb; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "FK_990da5f8a5976f2d02cf60fbdcb" FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: menu_categories FK_a1650861201d802c0ad078fff8e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT "FK_a1650861201d802c0ad078fff8e" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: stock_movements FK_b04c2008fe69e6036b93e21b319; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "FK_b04c2008fe69e6036b93e21b319" FOREIGN KEY (actor_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: recipes FK_ba90e79c045f10f0bcc6fbcd5cb; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT "FK_ba90e79c045f10f0bcc6fbcd5cb" FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: stock_movements FK_c0ab59f8bdb538daa034f63da4f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "FK_c0ab59f8bdb538daa034f63da4f" FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: organization_subscriptions FK_ee120ecc7d96135bd947a1ea7ae; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_subscriptions
    ADD CONSTRAINT "FK_ee120ecc7d96135bd947a1ea7ae" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: recipe_ingredients FK_f240137e0e13bed80bdf64fed53; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT "FK_f240137e0e13bed80bdf64fed53" FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;


--
-- Name: staff FK_f31b0fb22aad9920dd3aa509bf6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT "FK_f31b0fb22aad9920dd3aa509bf6" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_subscriptions FK_fd6a82efd1230697358620d2f29; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_subscriptions
    ADD CONSTRAINT "FK_fd6a82efd1230697358620d2f29" FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: audit_logs audit_logs_restaurant_restrict; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_restaurant_restrict FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT;


--
-- Name: data_exports data_exports_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: document_sequences document_sequences_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sequences
    ADD CONSTRAINT document_sequences_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT;


--
-- Name: notification_deliveries notification_deliveries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.platform_notifications(id) ON DELETE CASCADE;


--
-- Name: order_refunds order_refunds_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_refunds
    ADD CONSTRAINT order_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;


--
-- Name: org_feature_overrides org_feature_overrides_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_feature_overrides
    ADD CONSTRAINT org_feature_overrides_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_notes organization_notes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_notes
    ADD CONSTRAINT organization_notes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: platform_event_deliveries platform_event_deliveries_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_event_deliveries
    ADD CONSTRAINT platform_event_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.platform_events(id) ON DELETE CASCADE;


--
-- Name: support_ticket_events support_ticket_events_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_events
    ADD CONSTRAINT support_ticket_events_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: tax_documents tax_documents_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;


--
-- Name: tax_documents tax_documents_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


