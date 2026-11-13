/**
 * Ontario cities, towns and well-known communities accepted in the self-serve
 * box. A fixed list, so a visitor cannot make the service create (and pay to
 * test) an endless number of invented "cities". A place that is already in
 * the `cities` table is accepted as well; anything else gets a polite message.
 */
export const ONTARIO_MUNICIPALITIES: readonly string[] = [
  "Ajax", "Alliston", "Amherstburg", "Ancaster", "Angus", "Arnprior", "Aurora", "Aylmer",
  "Bancroft", "Barrie", "Beamsville", "Belleville", "Blind River", "Bolton", "Bowmanville", "Bracebridge",
  "Bradford", "Bradford West Gwillimbury", "Brampton", "Brant", "Brantford", "Brighton", "Brock", "Brockville",
  "Burlington", "Caledon", "Caledonia", "Cambridge", "Carleton Place", "Casselman", "Chatham", "Chatham-Kent",
  "Clarence-Rockland", "Clarington", "Cobourg", "Cochrane", "Collingwood", "Concord", "Cornwall", "Courtice",
  "Deep River", "Delhi", "Dryden", "Dundas", "Dunnville", "East Gwillimbury", "Elliot Lake", "Elmira",
  "Elora", "Embrun", "Espanola", "Essex", "Etobicoke", "Exeter", "Fergus", "Fort Erie",
  "Fort Frances", "Gananoque", "Georgetown", "Georgina", "Goderich", "Gravenhurst", "Greater Sudbury", "Grimsby",
  "Guelph", "Haldimand", "Halton Hills", "Hamilton", "Hanover", "Hawkesbury", "Hearst", "Huntsville",
  "Ingersoll", "Innisfil", "Iroquois Falls", "Kanata", "Kapuskasing", "Kawartha Lakes", "Kemptville", "Kenora",
  "Keswick", "Kincardine", "King City", "Kingston", "Kingsville", "Kirkland Lake", "Kitchener", "LaSalle",
  "Lakefield", "Lakeshore", "Leamington", "Lincoln", "Lindsay", "Listowel", "London", "Maple",
  "Markham", "Meaford", "Midland", "Milton", "Mississauga", "Mount Forest", "Napanee", "Nepean",
  "New Hamburg", "New Tecumseth", "Newcastle", "Newmarket", "Niagara Falls", "Niagara-on-the-Lake", "Nobleton", "Norfolk County",
  "North Bay", "North York", "Oakville", "Orangeville", "Orillia", "Orleans", "Oshawa", "Ottawa",
  "Owen Sound", "Paris", "Parry Sound", "Pelham", "Pembroke", "Penetanguishene", "Perth", "Petawawa",
  "Peterborough", "Petrolia", "Pickering", "Picton", "Port Colborne", "Port Dover", "Port Elgin", "Port Hope",
  "Port Perry", "Prescott", "Prince Edward County", "Quinte West", "Renfrew", "Richmond Hill", "Rockland", "Sarnia",
  "Saugeen Shores", "Sault Ste. Marie", "Scarborough", "Scugog", "Shelburne", "Simcoe", "Sioux Lookout", "Smiths Falls",
  "St. Catharines", "St. Marys", "St. Thomas", "Stayner", "Stittsville", "Stoney Creek", "Stouffville", "Stratford",
  "Strathroy", "Sturgeon Falls", "Sudbury", "Tecumseh", "Temiskaming Shores", "Thornbury", "Thornhill", "Thorold",
  "Thunder Bay", "Tilbury", "Tillsonburg", "Timmins", "Toronto", "Trenton", "Uxbridge", "Vaughan",
  "Walkerton", "Wallaceburg", "Wasaga Beach", "Waterdown", "Waterloo", "Welland", "West Lincoln", "Whitby",
  "Whitchurch-Stouffville", "Wiarton", "Winchester", "Windsor", "Wingham", "Woodbridge", "Woodstock", "Woolwich",
];

/** Same place however it is typed: case, accents, "St"/"Saint"/"Sainte", dots, hyphens and spaces. */
export function cityKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(saint|sainte|ste|st)\b\.?/g, "st")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_KEY = new Map(ONTARIO_MUNICIPALITIES.map((n) => [cityKey(n), n]));

/** The listed spelling of an Ontario municipality, or null when it is not on the list. */
export function ontarioMunicipality(input: string): string | null {
  return BY_KEY.get(cityKey(input)) ?? null;
}
