-- Which cities discovery searches first: lower runs sooner (default 100).
-- Among targets not yet searched this month, the order is priority, then the
-- target searched longest ago, then the order added.
alter table cities add column if not exists search_priority int not null default 100;
