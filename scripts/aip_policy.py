"""Licence policy for published SID/STAR overlay.

DRAW only where the state's terms explicitly allow reuse/display on a public
website. That is FAA CIFP for US airports (U.S. government work, 17 U.S.C.
§ 105; not copyrighted). Every other observed QTR airport is LINK-only: the
airport panel points at the official AIP / AD 2 page and we do not redraw
procedure geometry.

Not used: Navigraph, Jeppesen, OpenAIP, scraped commercial charts, or
EUROCONTROL EAD as a SID/STAR geometry source (EAD content is owned by
states; website terms do not grant a public-website redraw licence).
"""
from __future__ import annotations

UK_AIRAC = "2026-10-29"  # AIRAC 2611, same cycle as CIFP 261029
UK_AD2 = (
    "https://www.aurora.nats.co.uk/htmlAIP/Publications/"
    + UK_AIRAC
    + "-AIRAC/html/eAIP/EG-AD-2.{icao}-en-GB.html"
)

FAA_CIFP = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"
FAA_DTPP = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/"
FAA_NFDC = "https://nfdc.faa.gov/nfdcApps/services/ajv5/airportDisplay.jsp?airportId={iata}"

US = {
    "mode": "draw",
    "state": "United States",
    "aip": "FAA Coded Instrument Flight Procedures (CIFP), ARINC 424-18",
    "aip_url": FAA_CIFP,
    "ad2_url": FAA_NFDC,
    "ad2_label": "FAA airport diagram / d-TPP (official)",
    "terms_url": FAA_CIFP,
    "terms": (
        "FAA digital products including CIFP are U.S. government works and are "
        "not subject to copyright protection in the United States (17 U.S.C. § 105). "
        "The CIFP download page publishes the ARINC 424 dataset for public use. "
        "Straight lines between published fixes only. Not for navigation."
    ),
    "why": (
        "DRAW: FAA CIFP is a U.S. government work (17 U.S.C. § 105 / public domain "
        "in the US). Procedures are parsed from ARINC 424 PD/PE records, not from "
        "Navigraph or Jeppesen."
    ),
    "ident_mode": "cifp",
    "ident_terms": (
        "Per-flight SID/STAR names come from FAA CIFP (public domain). "
        "Matching uses published fix coordinates and paths already in CIFP. "
        "The label is estimated from the ADS-B track, not the ATC clearance."
    ),
}


def _link(state, aip, aip_url, terms_url, terms, ad2_url=None, ad2_label="official AIP AD 2"):
    return {
        "mode": "link",
        "state": state,
        "aip": aip,
        "aip_url": aip_url,
        "ad2_url": ad2_url or aip_url,
        "ad2_label": ad2_label,
        "terms_url": terms_url or aip_url,
        "terms": terms,
        "why": (
            "LINK only: " + terms + " No SID/STAR geometry is redrawn on this site."
        ),
        "ident_mode": "none",
        "ident_terms": (
            "Name-only identification still needs that state's SID/STAR coding (the ordered fix "
            "sequence that makes a name a procedure). Individual published waypoints (AIP ENR 4.4, "
            "FAA/OurAirports navaids) are factual coordinates but do not associate a SID/STAR name. "
            "OpenAIP is CC BY-NC and is not used. NATS UK AIS terms forbid redistributing AIS products; "
            "DFS, Airservices, NAV CANADA and others require permission. Those coding tables were not "
            "ingested, so this site does not assign procedure names here and does not redraw charts. "
            "The toggle only shows this assessment — names and fixes are never fabricated."
        ),
    }


NATS = (
    "NATS UK AIS terms (https://nats-uk.ead-it.com/cms-nats/opencms/en/agb) require "
    "that the user must not sell, sublicense or redistribute AIS products in the "
    "original published form. That forbids redrawing EGLL (and other UK) SID/STAR "
    "charts on a public website."
)
DFS = (
    "DFS Germany AIP datasets terms (https://aip.dfs.de/datasets) forbid reproducing "
    "or redistributing AIP data without prior written permission."
)
AIRSERVICES = (
    "Airservices Australia AIP/DAP: view unaltered on screen for personal "
    "non-commercial use only; reproduction, redistribution or caching requires a "
    "licence (https://www.airservicesaustralia.com/aip/aip.asp)."
)
NAVCAN = (
    "NAV CANADA AIP is copyright; copying, reproducing or sharing without prior "
    "written permission is not allowed (https://www.navcanada.ca/en/aeronautical-information/aip-canada.aspx)."
)
QCAA = (
    "Qatar CAA website materials are for personal, non-commercial use; the eAIP "
    "does not grant a licence to redraw SID/STAR on a public website "
    "(https://www.caa.gov.qa/en/aeronautical-information-management)."
)
EAD = (
    "EUROCONTROL EAD Basic website content is © EUROCONTROL; non-commercial "
    "redistribution needs attribution and commercial use needs written permission. "
    "Underlying AIP data remains owned by the states. Not used as a geometry source."
)
NO_GRANT = (
    "The state's public AIP/eAIP terms do not explicitly allow reuse or display of "
    "SID/STAR coding tables or charts on a third-party public website."
)

# Two-letter ICAO prefixes for observed QTR airports (K* handled separately).
PREFIX = {
    "PH": US,  # Hawaii (PHNL)
    "PA": US,
    "PF": US,
    "TJ": US,
    "TI": US,
    "BI": _link("Iceland", "Isavia AIP", "https://eaip.isavia.is/", "https://eaip.isavia.is/", NO_GRANT + " " + EAD),
    "CY": _link("Canada", "NAV CANADA AIP Canada", "https://www.navcanada.ca/en/aeronautical-information/aip-canada.aspx", "https://www.navcanada.ca/en/aeronautical-information/aip-canada.aspx", NAVCAN),
    "DA": _link("Algeria", "ENNA AIP", "https://www.sia-enna.dz/", "https://www.sia-enna.dz/", NO_GRANT),
    "DT": _link("Tunisia", "OACA AIP", "https://www.oaca.nat.tn/", "https://www.oaca.nat.tn/", NO_GRANT),
    "EB": _link("Belgium", "skeyes / Belgocontrol eAIP", "https://ops.skeyes.be/html/belgocontrol_static/eaip/index.html", "https://ops.skeyes.be/html/belgocontrol_static/eaip/index.html", NO_GRANT + " " + EAD),
    "ED": _link("Germany", "DFS AIP Germany", "https://aip.dfs.de/basicIFR/", "https://aip.dfs.de/datasets", DFS, ad2_url="https://aip.dfs.de/basicIFR/", ad2_label="DFS AIP (AD 2)"),
    "EF": _link("Finland", "Fintraffic AIS AIP", "https://ais.fi/", "https://ais.fi/", NO_GRANT + " " + EAD),
    "EG": _link("United Kingdom", "NATS UK AIP (eAIP / Aurora)", "https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/", "https://nats-uk.ead-it.com/cms-nats/opencms/en/agb", NATS, ad2_url=UK_AD2, ad2_label="NATS eAIP AD 2 (official)"),
    "EH": _link("Netherlands", "LVNL AIP Netherlands", "https://www.lvnl.nl/", "https://www.lvnl.nl/", NO_GRANT + " " + EAD),
    "EI": _link("Ireland", "IAA Aeronautical Information Services", "https://www.iaa.ie/safety/aeronautical-information-services", "https://www.iaa.ie/safety/aeronautical-information-services", NO_GRANT + " " + EAD),
    "EK": _link("Denmark", "Naviair AIM AIP", "https://aim.naviair.dk/", "https://aim.naviair.dk/", NO_GRANT + " " + EAD),
    "EN": _link("Norway", "Avinor AIS AIP", "https://ais.avinor.no/", "https://ais.avinor.no/", NO_GRANT + " " + EAD),
    "EP": _link("Poland", "PANSA AIS AIP", "https://www.pansa.pl/en/ais/", "https://www.pansa.pl/en/ais/", NO_GRANT + " " + EAD),
    "ES": _link("Sweden", "LFV AIP Sweden", "https://aro.lfv.se/", "https://aro.lfv.se/", NO_GRANT + " " + EAD),
    "FA": _link("South Africa", "ATNS AIP", "https://www.atns.co.za/", "https://www.atns.co.za/", NO_GRANT),
    "FN": _link("Angola", "ENANA AIP", "https://www.enana.co.ao/", "https://www.enana.co.ao/", NO_GRANT),
    "FS": _link("Seychelles", "SCAA AIP", "https://www.scaa.sc/", "https://www.scaa.sc/", NO_GRANT),
    "GM": _link("Morocco", "ONDA AIP", "https://www.onda.ma/", "https://www.onda.ma/", NO_GRANT),
    "HE": _link("Egypt", "NANSC AIP", "https://www.nansceg.net/", "https://www.nansceg.net/", NO_GRANT),
    "HK": _link("Kenya", "KCAA AIP", "https://www.kcaa.or.ke/", "https://www.kcaa.or.ke/", NO_GRANT),
    "LB": _link("Bulgaria", "BULATSA AIP", "https://www.bulatsa.com/", "https://www.bulatsa.com/", NO_GRANT + " " + EAD),
    "LC": _link("Cyprus", "DCAC AIP", "https://www.mcw.gov.cy/mcw/dca/dca.nsf/", "https://www.mcw.gov.cy/mcw/dca/dca.nsf/", NO_GRANT + " " + EAD),
    "LD": _link("Croatia", "Croatia Control AIP", "https://www.crocontrol.hr/", "https://www.crocontrol.hr/", NO_GRANT + " " + EAD),
    "LE": _link("Spain", "ENAIRE AIP Spain", "https://aip.enaire.es/", "https://aip.enaire.es/", NO_GRANT + " " + EAD, ad2_url="https://aip.enaire.es/", ad2_label="ENAIRE AIP (AD 2)"),
    "LF": _link("France", "SIA AIP France", "https://www.sia.aviation-civile.gouv.fr/", "https://www.sia.aviation-civile.gouv.fr/", "Service d'information aéronautique (DGAC/SIA) publications are copyright; no explicit grant to redraw SID/STAR on a public website.", ad2_url="https://www.sia.aviation-civile.gouv.fr/", ad2_label="SIA AIP (AD 2)"),
    "LG": _link("Greece", "HCAA AIP", "https://www.hcaa.gr/", "https://www.hcaa.gr/", NO_GRANT + " " + EAD),
    "LH": _link("Hungary", "HungaroControl AIP", "https://www.hungarocontrol.hu/", "https://www.hungarocontrol.hu/", NO_GRANT + " " + EAD),
    "LI": _link("Italy", "ENAV AIP Italy", "https://www.enav.it/", "https://www.enav.it/", NO_GRANT + " " + EAD),
    "LK": _link("Czechia", "ŘLP AIM AIP", "https://aim.rlp.cz/", "https://aim.rlp.cz/", NO_GRANT + " " + EAD),
    "LM": _link("Malta", "Transport Malta AIS AIP", "https://www.transport.gov.mt/", "https://www.transport.gov.mt/", NO_GRANT + " " + EAD),
    "LO": _link("Austria", "Austro Control AIP", "https://eaip.austrocontrol.at/", "https://eaip.austrocontrol.at/", NO_GRANT + " " + EAD),
    "LP": _link("Portugal", "NAV Portugal AIP", "https://www.nav.pt/", "https://www.nav.pt/", NO_GRANT + " " + EAD),
    "LR": _link("Romania", "ROMATSA AIP", "https://www.romatsa.ro/", "https://www.romatsa.ro/", NO_GRANT + " " + EAD),
    "LS": _link("Switzerland", "skyguide AIP Switzerland", "https://www.skyguide.ch/", "https://www.skyguide.ch/", NO_GRANT + " " + EAD),
    "LT": _link("Türkiye", "DHMI AIP", "https://www.dhmi.gov.tr/", "https://www.dhmi.gov.tr/", NO_GRANT),
    "LY": _link("Serbia", "SMATSA AIP", "https://www.smatsa.rs/", "https://www.smatsa.rs/", NO_GRANT + " " + EAD),
    "MP": _link("Panama", "AAC AIP", "https://www.aeronautica.gob.pa/", "https://www.aeronautica.gob.pa/", NO_GRANT),
    "NZ": _link("New Zealand", "AIP New Zealand", "https://www.aip.net.nz/", "https://www.aip.net.nz/", "AIP New Zealand is copyright Airways / CAA; no explicit grant to redraw SID/STAR on a public website."),
    "OE": _link("Saudi Arabia", "GACA / SANS AIP", "https://gaca.gov.sa/", "https://gaca.gov.sa/", NO_GRANT),
    "OI": _link("Iran", "CAO AIP", "https://www.cao.ir/", "https://www.cao.ir/", NO_GRANT),
    "OJ": _link("Jordan", "CARC AIP", "https://www.carc.jo/", "https://www.carc.jo/", NO_GRANT),
    "OK": _link("Kuwait", "DGCA Kuwait AIP", "https://www.dgca.gov.kw/", "https://www.dgca.gov.kw/", NO_GRANT),
    "OL": _link("Lebanon", "DGCA Lebanon AIP", "https://www.dgca.gov.lb/", "https://www.dgca.gov.lb/", NO_GRANT),
    "OM": _link("United Arab Emirates", "GCAA AIP UAE", "https://www.gcaa.gov.ae/", "https://www.gcaa.gov.ae/", "UAE GCAA AIP is an official AIS product; no explicit grant to redraw SID/STAR on a public website."),
    "OO": _link("Oman", "CAA Oman AIP", "https://www.caa.gov.om/", "https://www.caa.gov.om/", NO_GRANT),
    "OP": _link("Pakistan", "PCAA AIP", "https://caapakistan.com.pk/", "https://caapakistan.com.pk/", NO_GRANT),
    "OR": _link("Iraq", "GCAA Iraq AIP", "https://www.icaa.gov.iq/", "https://www.icaa.gov.iq/", NO_GRANT),
    "OS": _link("Syria", "SCAA AIP", "https://www.mot.gov.sy/", "https://www.mot.gov.sy/", NO_GRANT),
    "OT": _link("Qatar", "QCAA AIM / eAIP", "https://www.caa.gov.qa/en/aeronautical-information-management", "https://www.caa.gov.qa/en/aeronautical-information-management", QCAA, ad2_url="https://www.caa.gov.qa/en/aeronautical-information-management", ad2_label="QCAA AIM / eAIP (AD 2)"),
    "RJ": _link("Japan", "JCAB AIS Japan AIP", "https://www.mlit.go.jp/en/koku/", "https://www.mlit.go.jp/en/koku/", NO_GRANT),
    "RK": _link("Republic of Korea", "KOCA AIM AIP", "https://www.koca.go.kr/", "https://www.koca.go.kr/", NO_GRANT),
    "RP": _link("Philippines", "CAAP AIP", "https://caap.gov.ph/", "https://caap.gov.ph/", NO_GRANT),
    "SA": _link("Argentina", "ANAC / EANA AIP", "https://www.anac.gob.ar/", "https://www.anac.gob.ar/", NO_GRANT),
    "SB": _link("Brazil", "DECEA AISWEB AIP", "https://aisweb.decea.mil.br/", "https://aisweb.decea.mil.br/", "DECEA AISWEB AIP is an official AIS product; no explicit grant to redraw SID/STAR on a public website."),
    "UA": _link("Kazakhstan", "Kazaeronavigatsia AIP", "https://www.ans.kz/", "https://www.ans.kz/", NO_GRANT),
    "UD": _link("Armenia", "ARMATS AIP", "https://www.armats.am/", "https://www.armats.am/", NO_GRANT),
    "UG": _link("Georgia", "Sakaeronavigatsia AIP", "https://airnav.ge/", "https://airnav.ge/", NO_GRANT),
    "UT": _link("Uzbekistan", "Uzaeronavigation AIP", "https://www.uzairnavigation.uz/", "https://www.uzairnavigation.uz/", NO_GRANT),
    "UU": _link("Russian Federation", "FAVT CAI AIP", "https://www.favt.gov.ru/", "https://www.favt.gov.ru/", NO_GRANT),
    "VA": _link("India", "AAI AIM India AIP", "https://aim-india.aai.aero/", "https://aim-india.aai.aero/", "AAI AIM India AIP requires authorised access; no explicit grant to redraw SID/STAR on a public website."),
    "VE": _link("India", "AAI AIM India AIP", "https://aim-india.aai.aero/", "https://aim-india.aai.aero/", "AAI AIM India AIP requires authorised access; no explicit grant to redraw SID/STAR on a public website."),
    "VG": _link("Bangladesh", "CAAB AIP", "https://caab.gov.bd/", "https://caab.gov.bd/", NO_GRANT),
    "VH": _link("Hong Kong, China", "CAD Hong Kong AIP", "https://www.cad.gov.hk/", "https://www.cad.gov.hk/", NO_GRANT),
    "VI": _link("India", "AAI AIM India AIP", "https://aim-india.aai.aero/", "https://aim-india.aai.aero/", "AAI AIM India AIP requires authorised access; no explicit grant to redraw SID/STAR on a public website."),
    "VM": _link("Macao, China", "AACM AIP", "https://www.aacm.gov.mo/", "https://www.aacm.gov.mo/", NO_GRANT),
    "VN": _link("Nepal", "CAAN AIP", "https://caanepal.gov.np/", "https://caanepal.gov.np/", NO_GRANT),
    "VO": _link("India", "AAI AIM India AIP", "https://aim-india.aai.aero/", "https://aim-india.aai.aero/", "AAI AIM India AIP requires authorised access; no explicit grant to redraw SID/STAR on a public website."),
    "VT": _link("Thailand", "AEROTHAI AIP", "https://www.aerothai.co.th/", "https://www.aerothai.co.th/", NO_GRANT),
    "VV": _link("Viet Nam", "VATM AIP", "https://www.vatm.vn/", "https://www.vatm.vn/", NO_GRANT),
    "WA": _link("Indonesia", "AirNav Indonesia / DGCA AIP", "https://aimindonesia.dephub.go.id/", "https://aimindonesia.dephub.go.id/", NO_GRANT),
    "WI": _link("Indonesia", "AirNav Indonesia / DGCA AIP", "https://aimindonesia.dephub.go.id/", "https://aimindonesia.dephub.go.id/", NO_GRANT),
    "WM": _link("Malaysia", "CAAM AIP", "https://aip.caam.gov.my/", "https://aip.caam.gov.my/", NO_GRANT),
    "WS": _link("Singapore", "CAAS AIP Singapore", "https://www.caas.gov.sg/", "https://www.caas.gov.sg/", NO_GRANT),
    "YB": _link("Australia", "Airservices Australia AIP / DAP", "https://www.airservicesaustralia.com/aip/aip.asp", "https://www.airservicesaustralia.com/aip/aip.asp", AIRSERVICES, ad2_url="https://www.airservicesaustralia.com/aip/aip.asp", ad2_label="Airservices AIP / DAP (AD 2)"),
    "YM": _link("Australia", "Airservices Australia AIP / DAP", "https://www.airservicesaustralia.com/aip/aip.asp", "https://www.airservicesaustralia.com/aip/aip.asp", AIRSERVICES, ad2_url="https://www.airservicesaustralia.com/aip/aip.asp", ad2_label="Airservices AIP / DAP (AD 2)"),
    "YP": _link("Australia", "Airservices Australia AIP / DAP", "https://www.airservicesaustralia.com/aip/aip.asp", "https://www.airservicesaustralia.com/aip/aip.asp", AIRSERVICES, ad2_url="https://www.airservicesaustralia.com/aip/aip.asp", ad2_label="Airservices AIP / DAP (AD 2)"),
    "YS": _link("Australia", "Airservices Australia AIP / DAP", "https://www.airservicesaustralia.com/aip/aip.asp", "https://www.airservicesaustralia.com/aip/aip.asp", AIRSERVICES, ad2_url="https://www.airservicesaustralia.com/aip/aip.asp", ad2_label="Airservices AIP / DAP (AD 2)"),
    "ZB": _link("China", "CAAC AIP", "https://www.caac.gov.cn/", "https://www.caac.gov.cn/", NO_GRANT),
    "ZG": _link("China", "CAAC AIP", "https://www.caac.gov.cn/", "https://www.caac.gov.cn/", NO_GRANT),
}

LETTER = {
    "K": US,
    "C": PREFIX["CY"],
    "E": _link("Europe (national AIS)", "National AIP / EUROCONTROL EAD Basic", "https://www.ead.eurocontrol.int/", "https://www.ead.eurocontrol.int/", EAD),
    "L": _link("Europe (national AIS)", "National AIP / EUROCONTROL EAD Basic", "https://www.ead.eurocontrol.int/", "https://www.ead.eurocontrol.int/", EAD),
    "O": _link("Middle East (national AIS)", "National AIP", "https://www.icao.int/", "https://www.icao.int/", NO_GRANT),
    "Y": PREFIX["YM"],
    "Z": PREFIX["ZB"],
    "V": PREFIX["VA"],
    "W": PREFIX["WS"],
    "R": PREFIX["RJ"],
    "S": PREFIX["SB"],
    "U": PREFIX["UU"],
    "F": PREFIX["FA"],
    "H": PREFIX["HE"],
    "D": PREFIX["DA"],
    "G": PREFIX["GM"],
    "M": PREFIX["MP"],
    "N": PREFIX["NZ"],
    "P": US,
    "B": PREFIX["BI"],
}

INDIA_NMI = PREFIX["VA"]


def _fmt(url, icao, iata):
    if not url:
        return url
    try:
        return url.format(icao=icao or "", iata=iata or "")
    except (KeyError, IndexError, ValueError):
        return url


def policy_for(icao, iata=None, name=None):
    """Return a copy of the draw/link policy for one airport."""
    icao = (icao or "").strip().upper()
    iata = (iata or "").strip().upper()
    if icao.startswith("IN-") or (iata == "NMI"):
        p = dict(INDIA_NMI)
    elif len(icao) == 4 and icao[0] == "K":
        p = dict(US)
    elif len(icao) >= 2 and icao[:2] in PREFIX:
        p = dict(PREFIX[icao[:2]])
    elif icao[:1] in LETTER:
        p = dict(LETTER[icao[:1]])
    else:
        p = _link(
            "Unknown / not coded",
            "National AIP",
            "https://www.icao.int/",
            "https://www.icao.int/",
            NO_GRANT,
        )
    p["ad2_url"] = _fmt(p.get("ad2_url"), icao, iata)
    p["aip_url"] = _fmt(p.get("aip_url"), icao, iata)
    p["icao"] = icao
    p["iata"] = iata
    return p


def is_draw(icao, iata=None):
    return policy_for(icao, iata).get("mode") == "draw"
