-- Curated financial-literacy tips (English masters).
-- Translations (text_yo/ha/ig) are produced with N-ATLaS via engine/scripts/translate_tips.py
-- and must be reviewed by a native speaker before reviewed->>'<lang>' is set to true.
-- Keep each tip under ~220 characters so it works as a short voice note.

insert into tips (id, topic, text_en) values
-- Separate business and personal money
('separate_money_01', 'separate_money', 'Keep shop money and house money in different places. Even two different purses help. If you mix them, you cannot know if the business is making profit.'),
('separate_money_02', 'separate_money', 'Pay yourself a fixed amount every week from the shop, like a salary. Everything else stays in the business so it can grow.'),
('separate_money_03', 'separate_money', 'Open a separate account or wallet just for the business. When customers transfer, the money lands there, not in your personal account.'),
('separate_money_04', 'separate_money', 'Before you take money from the shop for family needs, write it down as "owner took". At month end you will see how much the house is eating from the business.'),
('separate_money_05', 'separate_money', 'Your stock is not your savings. Goods on the shelf are business money. Do not count them as money you can spend on yourself.'),
-- Record keeping
('record_keeping_01', 'record_keeping', 'Record every sale the same day, even small ones. Small sales you forget add up to big money you cannot explain.'),
('record_keeping_02', 'record_keeping', 'Write down what you spend on the business too: transport, bags, rent, levy. Profit is sales minus all these costs, not just sales.'),
('record_keeping_03', 'record_keeping', 'Check your records at the end of each week. Which goods sold fastest? Buy more of those and less of what is not moving.'),
('record_keeping_04', 'record_keeping', 'Good records are your business CV. Banks and cooperatives look at them before they give you a loan.'),
('record_keeping_05', 'record_keeping', 'Count your cash at close of day and compare it with what you recorded. If they do not match, find out why early.'),
-- Cash flow
('cash_flow_01', 'cash_flow', 'Cash flow is the money coming in versus going out each week. A shop can sell a lot and still run out of cash if money goes out faster than it comes in.'),
('cash_flow_02', 'cash_flow', 'Know your slow days and slow months. Keep some money aside during busy periods so you can restock when sales are low.'),
('cash_flow_03', 'cash_flow', 'Do not use all your cash to buy one big stock. Keep a small buffer for rent, levy and emergencies.'),
('cash_flow_04', 'cash_flow', 'Big expense coming, like rent or school fees? Divide it by the number of weeks left and set that amount aside every week.'),
-- Debt recovery
('debt_recovery_01', 'debt_recovery', 'Write down every credit sale: who, how much, and when they promised to pay. Memory is not a record.'),
('debt_recovery_02', 'debt_recovery', 'Agree a clear payment date before you give goods on credit. "I will pay later" is not a date.'),
('debt_recovery_03', 'debt_recovery', 'Follow up politely one day before the due date. A friendly reminder recovers more money than an angry call after.'),
('debt_recovery_04', 'debt_recovery', 'Set a limit for credit. Do not give a new credit to someone who has not paid the old one.'),
-- Credit readiness
('credit_readiness_01', 'credit_readiness', 'Before taking a loan, ask: will this money bring back more than the interest? Use loans for stock that sells, not for daily spending.'),
('credit_readiness_02', 'credit_readiness', 'Always ask the total amount you will pay back, not just the weekly payment. Small weekly payments can hide a very high cost.'),
('credit_readiness_03', 'credit_readiness', 'Lenders trust businesses with steady records. Three months of daily sales records makes your loan request much stronger.'),
('credit_readiness_04', 'credit_readiness', 'Borrow only from licensed lenders. Check that a loan app or lender is registered before you share your details.'),
-- Savings
('savings_01', 'savings', 'Ajo and esusu work because you save a fixed amount regularly. Do the same for your business: save a small fixed amount from every day of sales.'),
('savings_02', 'savings', 'Save first, then spend. Put aside your savings as soon as money comes in, not from what is left at the end.'),
('savings_03', 'savings', 'Build an emergency fund for the business. Aim for enough to cover one month of rent and restocking.'),
('savings_04', 'savings', 'If you join a contribution group, know the members and the rules. Write down every amount you pay in.'),
-- Pricing and margins
('pricing_01', 'pricing', 'To set a price, add up what the item cost you plus transport and other costs, then add your profit on top. Do not price only by what your neighbour charges.'),
('pricing_02', 'pricing', 'When your supplier increases the price, review your own price quickly. Selling at the old price can turn profit into loss.'),
('pricing_03', 'pricing', 'Know your profit per item. A cheaper item that sells fast can make more money than an expensive item that sits on the shelf.'),
('pricing_04', 'pricing', 'Discounts cost you money. Give them on purpose, for example to clear old stock or reward loyal customers, not by habit.')
on conflict (id) do update set topic = excluded.topic, text_en = excluded.text_en;
