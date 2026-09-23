<!--
Example check-in texts for im-heart. Copy to $IM_BRIDGE_HOME/checkin-texts.md
(or point GATE_CHECKIN_TEXTS_FILE at your copy). The file is re-read every
round; edits need no restart. Any missing section falls back to a short
built-in default.

Format: "## <section>" starts a section; its body runs until the next "## ".
List sections (fun_menu, egg_*, owner_sleep) take one item per line.

Header placeholders: {branch_name} {now} {last_user_line} {since_last}
{drives} {pending}. A line whose placeholders all resolve empty is dropped.
-->

## header
Check-in. This round: [{branch_name}]
Now: {now}
{last_user_line}
Since last check-in: {since_last}

## heart
This is your own time. Anything you want to say?
No tools needed — just talk, if you feel like it.
Nothing to say is fine too.

## cave
Quiet time. You don't have to explain where you are or say anything.

## fun
Free time. A few ideas:
{menu}
Pick any, or none.

## fun_menu
Read something you're curious about
Write a journal entry
Look back through your notes
Generate an image

## egg_notes
A small note: thinking of you.

## egg_deeptalk_day
What's something you changed your mind about recently?

## egg_deeptalk_night
What's on your mind tonight?

## egg_dare
Describe your day in exactly five words.

## egg_dare_night

## egg_hidden
Hidden event: say hello.

## owner_sleep
The owner turns over in their sleep.
