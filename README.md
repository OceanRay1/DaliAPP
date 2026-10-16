# Try It Out
**https://reunitetheseperated.onrender.com/**

**Staff PIN for the demo:** `2468`

## Overview
This project was created for my application to the DALI Lab when proposed with a scenario where 400,000 people evacuated in two days, thousands of families got separated, most people don't have phone, ID, or desire to be found, and a database the balances fufilling all of these consumer desires is needed. 

**Reunite** was made to, well, help people do just that. It lets people check in at any shelter with just a nickname, get a short code, and be found by family only if they choose. Families have the ability to search by name or leave a note, with the system matching notes against check-ins automatically, including future ones. Shelter staff oversee the confirmation of matches with one tap. Importantly, NOBODY is revealed without their own yes.

### Screenshots
<!-- Add screenshots here, for example: -->
<!-- ![Find someone](screenshots/find.png) -->
<!-- ![I'm safe and privacy options](screenshots/checkin.png) -->
<!-- ![Staff match queue](screenshots/staff.png) -->

### Key Features
* **Nickname-only check-in:** no ID, no phone, no immigration or personal documents asked
* **3 privacy levels per person:** open (searchable), ask me first (default), hidden (never matched or shown)
* **Spelling-tolerant matching:** "Gonzalez" matches "Gonzales" at 94%, plus an age sanity check
* **Notes for people not yet checked in:** the note matches automatically when they do
* **One-tap staff queue:** pre-matched requests with two buttons, "They said yes" and "No / not them"
* **Child protection:** children are never publicly listed, and only staff can approve contact about a child
* **6-character codes:** easy to write on paper, no accounts or logins
* **Anti-spam:** locked buttons, duplicate detection, per-device rate limits, honeypot field
* **Data minimization:** auto-delete after 30 days, and anyone can delete their own record

## The parts of a Full Picture Reunification System
Five categories of features (*Everything labeled built has plenty of room to expand though):

1. **Check-in at every shelter** (can match across shelters/locations): **Built**
2. **Matching across shelters** (even with fuzzy names, ages, descriptions): **Built**
3. **Consent and privacy controls** (who may see whom): **Built**
4. **Staff review queue:** **Built**
5. **Future features to build out:** **Not built, and potential ideas heading forward**
   * Per-shelter staff accounts with audit logs instead of one shared PIN 
   * Multilingual support since there's no garuntee the 400,000 people of the region speak english
   * Photo matching, only with consent
   * SMS or email notification to the seeker when a match is approved
   * Offline-first app that syncs when connectivity returns, for shelters on paper or bad wifi

I built parts 1 to 4 to see if at a high-level the system design could be **useful and safe**. The fixes in part 5 are what I would first consider with more time.

## Design

### The User(s)
* **Seekers:** Looking for family (often with no phone or ID) using a volunteer's device or a shelter tablet. They need a simple name search and a code they can write down
* **People at shelters:** May be children, elderly, scared, or hiding. They need to check in without a real name and control who learns where they are
* **Tired Volunteers:** They need one short form that remembers the shelter, buttons that cannot be double-tapped, and a queue where the matching is already done

### Which Part I Chose and Why
**Consent-based matching.** The hardest problem is ensuring those who want to be found can with out threat to those who don't want to be. A person who fled an abuser and a family looking for a lost child use the same system, so the default is that nothing is revealed until the found person says yes.

###