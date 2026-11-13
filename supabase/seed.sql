-- Launch configuration: sectors, cities, question sets, approved answers.
-- Safe to re-run (upserts).

insert into sectors (slug, name, patient_noun, places_query, places_included_type, regulator_note) values
  ('dental', 'dental clinic', 'dentist', 'dentist in {city}, Ontario', 'dentist',
   'Check all wording against the Royal College of Dental Surgeons of Ontario (RCDSO) advertising standards before publishing.'),
  ('family', 'walk-in and family clinic', 'family doctor or walk-in clinic', 'walk-in clinic family doctor in {city}, Ontario', 'doctor',
   'Check all wording against the College of Physicians and Surgeons of Ontario (CPSO) advertising policy before publishing.'),
  ('medspa', 'medspa', 'medspa', 'medical spa in {city}, Ontario', null,
   'Check all wording against the advertising rules of the regulator of each practitioner named (for example CPSO or the College of Nurses of Ontario) and Health Canada rules on prescription drug advertising before publishing.')
on conflict (slug) do update set
  name = excluded.name, patient_noun = excluded.patient_noun, places_query = excluded.places_query,
  places_included_type = excluded.places_included_type, regulator_note = excluded.regulator_note;

insert into cities (name, province, lat, lng, radius_m) values
  ('Barrie', 'ON', 44.3894, -79.6903, 15000),
  ('Milton', 'ON', 43.5183, -79.8774, 12000)
on conflict (name, province) do nothing;

insert into discovery_targets (sector_id, city_id)
select s.id, c.id from sectors s cross join cities c
on conflict do nothing;

insert into question_sets (sector_id, version, questions)
select id, 1, q.questions from sectors s
join (values
  ('dental', '[
    "I just moved to {city}, Ontario. Can you recommend a good dentist that is accepting new patients?",
    "Which dentists in {city} can see me the same day for a dental emergency?",
    "I do not have dental insurance. Which dental clinics in {city} are affordable or list their prices?",
    "I am looking for a family dentist in {city} who is good with kids. Who would you suggest?",
    "Which dentists in {city} bill my insurance directly so I do not pay up front?",
    "Are there dentists in {city} open evenings or Saturdays?"
  ]'::jsonb),
  ('family', '[
    "Where can I find a family doctor accepting new patients in {city}, Ontario?",
    "Which walk-in clinics in {city} would you recommend? I need to see a doctor today.",
    "Which clinics in {city} offer virtual appointments with a doctor?",
    "I am new to {city}. Which medical clinic would you recommend for my family?",
    "Are there walk-in clinics in {city} open on evenings or weekends?",
    "Where in {city} can I get a physical or a medical form completed if I do not have a family doctor?"
  ]'::jsonb),
  ('medspa', '[
    "Can you recommend a reputable medspa in {city}, Ontario?",
    "Where can I get laser hair removal in {city}? Who would you recommend?",
    "Which clinics in {city} offer Botox done by a nurse or a doctor?",
    "I am looking for a medspa in {city} that lists its prices. Any suggestions?",
    "Where can I get a skin treatment for acne scars in {city}?",
    "Which aesthetic clinics in {city} are run by medical professionals?"
  ]'::jsonb)
) as q(slug, questions) on q.slug = s.slug
on conflict (sector_id, version) do update set questions = excluded.questions;

insert into chain_patterns (pattern, note) values
  ('dentalcorp', 'corporate dental group'),
  ('lifesmile', 'chain'),
  ('dental care centres', 'chain naming'),
  ('appletree', 'Appletree Medical Group'),
  ('shoppers drug mart', 'pharmacy chain'),
  ('rexall', 'pharmacy chain'),
  ('walmart', 'retail chain'),
  ('loblaw', 'retail chain'),
  ('medicentres', 'chain'),
  ('telus health', 'corporate'),
  ('maple', 'virtual care company'),
  ('laser clinics canada', 'chain'),
  ('dermapure', 'chain'),
  ('skinworks', 'chain'),
  ('spa medica', 'chain')
on conflict (pattern) do nothing;

insert into approved_answers (key, question, match_hints, answer) values
  ('how_email', 'How did you get my email address?',
   array['how did you get', 'where did you get my email', 'how did you find'],
   'Your clinic publishes this address on its own website. The report lists the exact page. If you would prefer not to hear from me, reply "unsubscribe" or use the link at the bottom of any email and I will not contact you again.'),
  ('what_tested', 'What exactly did you test?',
   array['what did you test', 'how did you test', 'which ai', 'what assistant'],
   'I asked an AI assistant with web search turned on the same questions a patient in your city would ask, and recorded every answer in full, including which clinics it named and the sources it used. The report names the assistant, the model and the date. The site checks look only at what is publicly visible on your website.'),
  ('price', 'How much does it cost?',
   array['how much', 'price', 'cost', 'fee'],
   'There are three options, all plus HST. The full report with fix files is 200 CAD, one time, with a retest four weeks later. Monthly reports are 150 CAD for the first month, then 50 CAD a month with a 3-month minimum: the same report, updated after a fresh retest each month. The full service plan is 200 CAD a month on a 12-month contract: I renovate your website or take it over, install every fix, retest each month and track the clinics named instead of you. The links in the report go straight to checkout.'),
  ('guarantee', 'Can you guarantee we will be recommended?',
   array['guarantee', 'promise', 'will we be', 'rank'],
   'No. Nobody can guarantee what an AI assistant will say. What I can do is make sure the facts patients ask about are stated clearly on your own site and are consistent across the directories the assistant reads, and then retest so you can see what changed.'),
  ('who_are_you', 'Who are you?',
   array['who are you', 'is this legit', 'is this a scam', 'what company'],
   'I run In The Answer, a small Ontario service that tests whether AI assistants name local clinics when patients ask for a recommendation. My name, business name and mailing address are at the bottom of every email.'),
  ('data_use', 'What do you do with our information?',
   array['privacy', 'data', 'what do you store'],
   'I store only what is public on your website and what the AI assistant answered, so the report can show its evidence. I do not collect patient information. The privacy page at intheanswer.ca/privacy has the details.')
on conflict (key) do update set question = excluded.question, match_hints = excluded.match_hints, answer = excluded.answer;
