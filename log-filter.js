// Filter logic for log.html filter pills
// Hides individual cards and collapses entire category sections if they are empty

document.addEventListener('DOMContentLoaded', function() {
  const pills = document.querySelectorAll('.filter-pill');
  const sections = document.querySelectorAll('.category-section');

  pills.forEach(pill => {
    pill.addEventListener('click', function() {
      // Manage active pill state
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      
      const filter = pill.getAttribute('data-filter');

      // Loop through each category section
      sections.forEach(section => {
        let hasVisibleCards = false;
        const cards = section.querySelectorAll('.article-card');
        
        // Loop through cards in this section
        cards.forEach(card => {
          if (filter === 'all' || card.getAttribute('data-category') === filter) {
            card.style.display = 'flex';
            hasVisibleCards = true;
          } else {
            card.style.display = 'none';
          }
        });

        // Hide the entire section (including the <h2> header) if no cards are visible
        if (hasVisibleCards) {
          section.style.display = 'block';
        } else {
          section.style.display = 'none';
        }
      });
    });
  });
});