-- Runs once on first Postgres container start (empty data volume).
-- oman_directus is created by POSTGRES_DB; this adds Camunda's database.

CREATE DATABASE oman_camunda OWNER oman;
