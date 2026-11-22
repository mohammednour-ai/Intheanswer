-- Which lines of a call the service wrote itself (the opening, what a lookup of the clinic's
-- name found, a closing line) and which the model wrote. The after-call review checks only the
-- model's lines against the brief; before this it flagged our own opening line on every call.
alter table call_turns add column if not exists fixed boolean not null default false;
