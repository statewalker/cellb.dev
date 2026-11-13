-- The database behind ```sql database=warehouse cells: run in an object of its own at build time,
-- each query's result precomputed for the page. Never served.
CREATE TABLE sales (region TEXT NOT NULL, amount INTEGER NOT NULL);
INSERT INTO sales VALUES ('East', 120), ('West', 80), ('East', 180), ('West', 120);
